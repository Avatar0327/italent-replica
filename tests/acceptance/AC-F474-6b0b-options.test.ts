import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  grantCodesDigest,
  MODULE_OBJECTS,
  STANDARD_GRANT_CODES,
  STANDARD_GRANT_DIGEST,
  STANDARD_GRANT_VERSION,
} from '@italent/domain';
import { validateCustomValue } from '../../apps/api/src/modules/employment/fields.js';
import { validatePartTimeCustomFields } from '../../apps/api/src/modules/employment/part-time/validation.js';
import { addMember, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { resultRows } from './AC-ORG-support.js';
import { fileAt, fileNow, grantCodesAt, resolveGrantBase } from './support/grant-baseline.js';

const database = useTestDb();
const base = '/api/tenant/employment/custom-fields';
const east = { value: 'east', label: '合成东区', enabled: true };
const west = { value: 'west', label: '合成西区', enabled: true };
const input = { name: '合成地区', objectType: 'employment', valueType: 'select', options: [east] };
const create = (w: PermissionWorld, body: object = input) =>
  w.api.request('POST', base, { ...w.asAdmin, ifMatch: 0, body });
const update = (w: PermissionWorld, id: string, revision: number, options: unknown, idempotencyKey = randomUUID()) =>
  w.api.request('PUT', `${base}/${id}/options`, {
    ...w.asAdmin,
    ifMatch: revision,
    idempotencyKey,
    body: { options },
  });
async function definition(w: PermissionWorld, body: object = input) {
  const response = await create(w, body);
  expect(response.status).toBe(201);
  return response.json();
}

describe('AC-F474-6b0b options 与单选下拉', () => {
  it('AC-F474-0B01 四对象创建 select，非 select 禁止 options，严格校验选项结构和 50 项边界', async () => {
    const w = await seedPermissionWorld(database().db);
    for (const objectType of ['employment', 'contract', 'organization', 'personnel']) {
      const row = await definition(w, { ...input, objectType });
      expect(row).toMatchObject({ objectType, valueType: 'select', options: [east], revision: 1 });
      const response = await w.api.request('GET', `${base}?objectType=${objectType}`, w.asAdmin);
      expect((await response.json()).items).toContainEqual(row);
    }
    const fifty = Array.from({ length: 50 }, (_, i) => ({ value: `v${i}`, label: `合成${i}`, enabled: true }));
    expect((await create(w, { ...input, options: fifty })).status).toBe(201);
    for (const body of [
      { ...input, options: undefined },
      { ...input, options: [] },
      { ...input, options: null },
      { ...input, valueType: 'text' },
      { ...input, valueType: 'text', options: [] },
      { ...input, options: [...fifty, west] },
      { ...input, options: [east, east] },
      { ...input, options: [{ ...east, value: '' }] },
      { ...input, options: [{ ...east, enabled: 'yes' }] },
      { ...input, options: [{ ...east, unexpected: true }] },
    ])
      expect((await create(w, body)).status).toBe(400);
  });

  it('AC-F474-0B12 真实 PUT 新增、改名、停用、排序，CAS/重放/审计一致且旧选项不可删改编码', async () => {
    const w = await seedPermissionWorld(database().db);
    const row = await definition(w);
    const changes = [
      [east, west],
      [{ ...east, label: '合成新东区' }, west],
      [west, { ...east, label: '合成新东区', enabled: false }],
    ];
    for (const [index, options] of changes.entries()) {
      const command = randomUUID();
      const response = await update(w, row.id, index + 1, options, command);
      expect(response.status).toBe(200);
      const after = await response.json();
      expect(after).toMatchObject({ id: row.id, options, revision: index + 2, name: input.name });
      expect(await (await update(w, row.id, index + 1, options, command)).json()).toEqual(after);
    }
    expect((await update(w, row.id, 1, [east, west])).status).toBe(409);
    for (const options of [[west], [{ ...east, value: 'renamed' }, west], [], [east, east]]) {
      expect((await update(w, row.id, 4, options)).status).toBe(400);
    }
    const [saved] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`SELECT revision,options FROM employment_custom_field_objects WHERE id=${row.id}`),
      ),
    );
    expect(saved).toEqual({ revision: 4, options: changes[2] });
    const audit = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ before: unknown; after: unknown }>(
        await tx.execute(sql`SELECT before,after FROM audit_events WHERE object_id=${row.id}
        AND action='employment.custom_field.options' ORDER BY occurred_at,id`),
      ),
    );
    expect(audit).toHaveLength(3);
    expect(audit.map(({ after }) => (after as { revision: number }).revision).sort()).toEqual([2, 3, 4]);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          before: expect.objectContaining({ revision: 3, options: changes[1] }),
          after: expect.objectContaining({ revision: 4, options: changes[2] }),
        }),
      ]),
    );
  });

  it('AC-F474-0B02 新入口沿用配置授权，跨租户不可改，非 select 拒绝，继承与 options 共用 revision', async () => {
    const w = await seedPermissionWorld(database().db);
    const other = await seedPermissionWorld(database().db);
    const row = await definition(w);
    const member = await addMember(w, '合成普通成员');
    expect(
      (
        await w.api.request('PUT', `${base}/${row.id}/options`, {
          user: member.id,
          tenant: w.tenant.id,
          ifMatch: 1,
          body: { options: [east, west] },
        })
      ).status,
    ).toBe(403);
    expect((await update(other, row.id, 1, [east, west])).status).toBe(404);
    const plain = await definition(w, { name: '合成文本', objectType: 'employment', valueType: 'text' });
    expect((await update(w, plain.id, 1, [east])).status).toBe(400);
    expect((await update(w, row.id, 1, [east, west])).status).toBe(200);
    expect(
      (
        await w.api.request('PUT', `${base}/${row.id}/inheritance`, {
          ...w.asAdmin,
          ifMatch: 1,
          body: { inherit: false },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await w.api.request('PUT', `${base}/${row.id}/inheritance`, {
          ...w.asAdmin,
          ifMatch: 2,
          body: { inherit: false },
        })
      ).status,
    ).toBe(200);
    expect((await update(w, row.id, 2, [east, west])).status).toBe(409);
  });

  it('AC-F474-0B13 普通角色可更新 options/revision，所有元数据仍有列授权和触发器双重保护', async () => {
    const w = await seedPermissionWorld(database().db);
    const row = await definition(w);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      UPDATE employment_custom_field_objects SET options=${JSON.stringify([east, west])}::jsonb,revision=2
      WHERE id=${row.id}
    `),
    );
    for (const assignment of [
      "name='不能改'",
      "object_type='contract'",
      "value_type='text'",
      "code='不能改'",
      `id='${randomUUID()}'`,
      `tenant_id='${randomUUID()}'`,
      "created_at=now()+interval '1 day'",
    ]) {
      const statement = sql`UPDATE employment_custom_field_objects SET ${sql.raw(assignment)} WHERE id=${row.id}`;
      expect(pgErrorCode(await withTenant(w.db, w.tenant.id, (tx) => tx.execute(statement)).catch((e) => e))).toBe(
        '42501',
      );
      expect(
        pgErrorCode(
          await withTenant(w.db, w.tenant.id, async (tx) => {
            await tx.execute(sql`RESET ROLE`);
            await tx.execute(statement);
          }).catch((e) => e),
        ),
      ).toBe('55000');
    }
    for (const options of ['{}', '[]']) {
      expect(
        pgErrorCode(
          await withTenant(w.db, w.tenant.id, (tx) =>
            tx.execute(sql`
        UPDATE employment_custom_field_objects SET options=${options}::jsonb WHERE id=${row.id}
      `),
          ).catch((e) => e),
        ),
      ).toBe('23514');
    }
    const other = await seedPermissionWorld(database().db);
    expect(
      resultRows(
        await withTenant(w.db, other.tenant.id, (tx) =>
          tx.execute(sql`
      UPDATE employment_custom_field_objects SET revision=3 WHERE id=${row.id} RETURNING id
    `),
        ),
      ),
    ).toEqual([]);
  });

  it('AC-F474-0B05 select 值必须属于选项集，停用不能新选，原值和 null 合法', () => {
    const options = [east, { ...west, enabled: false }];
    const validate = (value: unknown, previous?: unknown) =>
      Reflect.apply(validateCustomValue, undefined, [value, 'select', options, previous]);
    expect(validate('east')).toBe('east');
    expect(validate('west', 'west')).toBe('west');
    expect(validate(null)).toBeNull();
    for (const value of ['west', 'missing', 1, false]) expect(() => validate(value)).toThrow();
    expect(() => validate('missing', 'missing')).toThrow();
  });

  it('AC-F474-0B06 真实租户定义进入现有值校验，停用后显式沿用原值与历史定义仍可读', async () => {
    const w = await seedPermissionWorld(database().db);
    const row = await definition(w);
    const ctx = {
      tenantId: w.tenant.id,
      userId: w.admin.id,
      now: new Date(),
      timezone: 'UTC',
      commandId: randomUUID(),
      expectedRevision: 1,
    };
    const validate = (value: unknown, previous = {}) =>
      withTenant(w.db, w.tenant.id, (tx) =>
        Reflect.apply(validatePartTimeCustomFields, undefined, [tx, ctx, { [row.id]: value }, previous]),
      );
    await expect(validate('east')).resolves.toMatchObject({ customFields: { [row.id]: 'east' } });
    await expect(validate('missing')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await update(w, row.id, 1, [{ ...east, enabled: false }])).status).toBe(200);
    await expect(validate('east')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(validate('east', { [row.id]: 'east' })).resolves.toMatchObject({ customFields: { [row.id]: 'east' } });
    const response = await w.api.request('GET', base, w.asAdmin);
    expect((await response.json()).items[0].options).toEqual([{ ...east, enabled: false }]);
  });

  it('AC-F474-0B09 options 是非系统字段，授权编码指纹与编码集合自洽', () => {
    expect(MODULE_OBJECTS.employmentCustomField.fields).toContainEqual({ code: 'options', system: false });
    expect(grantCodesDigest(STANDARD_GRANT_CODES)).toBe(STANDARD_GRANT_DIGEST);
  });

  it('AC-F474-0B09b 本 PR 不改授权编码：编码集合、版本、指纹和预置文件与基线逐字相同（F-097 动态基线）', async (context) => {
    // 基线不写死提交：CI 浅克隆只有 HEAD / HEAD^1，写死的历史提交取不到。
    // CI 设了 GRANT_BASE_REV=HEAD^1，解析不到会抛错（不静默通过）；本地取 merge-base，取不到才跳过并写明原因。
    const base = resolveGrantBase();
    if ('skip' in base) return context.skip(`F-097 动态基线：${base.skip}`);
    expect([...STANDARD_GRANT_CODES]).toEqual(await grantCodesAt(base.sha));
    const grants = fileAt(base.sha, 'packages/domain/src/platform/standard-grants.ts') ?? '';
    const version = /STANDARD_GRANT_VERSION\s*=\s*(\d+)/.exec(grants)?.[1];
    const digest = /STANDARD_GRANT_DIGEST\s*=\s*'([0-9a-f]+)'/.exec(grants)?.[1];
    expect(version, `基线 ${base.sha.slice(0, 8)} 上取不到 STANDARD_GRANT_VERSION`).toBeDefined();
    expect(digest, `基线 ${base.sha.slice(0, 8)} 上取不到 STANDARD_GRANT_DIGEST`).toBeDefined();
    expect(STANDARD_GRANT_VERSION).toBe(Number(version));
    expect(STANDARD_GRANT_DIGEST).toBe(digest);
    for (const path of ['standard-grants.ts', 'standard-presets.ts', 'standard-grant-changes.json']) {
      const file = `packages/domain/src/platform/${path}`;
      expect(fileNow(file), `${file} 与基线 ${base.how} 不一致`).toBe(fileAt(base.sha, file));
    }
  });
});
