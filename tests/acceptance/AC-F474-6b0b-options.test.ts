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
import {
  activeGrantChanges,
  checkGrantChanges,
  EMPTY_GRANT_CHANGES,
  GRANT_CHANGES_PATH,
  type GrantChanges,
} from '../../scripts/merge-main-lib.mjs';
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

const GRANTS_FILE = 'packages/domain/src/platform/standard-grants.ts';
const GRANT_FILES = [GRANTS_FILE, 'packages/domain/src/platform/standard-presets.ts', GRANT_CHANGES_PATH] as const;
const parseVersion = (text: string) => /STANDARD_GRANT_VERSION\s*=\s*(\d+)/.exec(text)?.[1];
const parseDigest = (text: string) => /STANDARD_GRANT_DIGEST\s*=\s*'([0-9a-f]+)'/.exec(text)?.[1];

interface GrantSnapshot {
  readonly codes: readonly string[];
  readonly version: string | number | undefined;
  readonly digest: string | undefined;
}

/**
 * 授权基线比较（与 AC-PLAT-F061-grants 同口径）：当前编码 = 基线编码 + 声明的 add − remove，由 checkGrantChanges 判定；
 * 没有声明（changes.json 与基线相同或增删都为空）时，版本、指纹、预置文件还须与基线逐字相同；有声明才允许它们变化。
 */
function grantBaselineProblems(input: {
  base: GrantSnapshot;
  head: GrantSnapshot;
  declared: GrantChanges;
  files: readonly { file: string; base: string | undefined; head: string | undefined }[];
}): string[] {
  const { base, head, declared, files } = input;
  const problems = [...checkGrantChanges({ baseCodes: base.codes, headCodes: head.codes, declared }).problems];
  if (declared.add.length > 0 || declared.remove.length > 0) return problems;
  if (String(head.version) !== String(base.version))
    problems.push(`没有声明授权变更，版本不应变：${base.version} → ${head.version}`);
  if (head.digest !== base.digest) problems.push(`没有声明授权变更，指纹不应变：${base.digest} → ${head.digest}`);
  for (const f of files) if (f.head !== f.base) problems.push(`没有声明授权变更，${f.file} 应与基线逐字相同`);
  return problems;
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

  it('AC-F474-0B09b 授权编码与分叉点基线一致：编码增删须在 changes.json 声明，没声明时版本、指纹、预置文件逐字相同（F-097 动态基线）', async (context) => {
    // 基线不写死提交：CI 浅克隆只有 HEAD / HEAD^1，写死的历史提交取不到。
    // CI 设了 GRANT_BASE_REV=HEAD^1，解析不到会抛错（不静默通过）；本地取 merge-base，取不到才跳过并写明原因。
    // 口径与 AC-PLAT-F061-grants 一致：当前编码 = 基线编码 + 声明的 add − remove；授权类 PR 有声明才允许版本 / 指纹 / 预置变化。
    const base = resolveGrantBase();
    if ('skip' in base) return context.skip(`F-097 动态基线：${base.skip}`);
    const baseGrants = fileAt(base.sha, GRANTS_FILE) ?? '';
    expect(parseVersion(baseGrants), `基线 ${base.sha.slice(0, 8)} 上取不到 STANDARD_GRANT_VERSION`).toBeDefined();
    expect(parseDigest(baseGrants), `基线 ${base.sha.slice(0, 8)} 上取不到 STANDARD_GRANT_DIGEST`).toBeDefined();
    const problems = grantBaselineProblems({
      base: { codes: await grantCodesAt(base.sha), version: parseVersion(baseGrants), digest: parseDigest(baseGrants) },
      head: { codes: STANDARD_GRANT_CODES, version: STANDARD_GRANT_VERSION, digest: STANDARD_GRANT_DIGEST },
      declared: activeGrantChanges(fileAt(base.sha, GRANT_CHANGES_PATH), fileNow(GRANT_CHANGES_PATH)),
      files: GRANT_FILES.map((file) => ({ file, base: fileAt(base.sha, file), head: fileNow(file) })),
    });
    expect(problems, `基线 ${base.how}（${base.sha.slice(0, 8)}）`).toEqual([]);
  });

  it('AC-F474-0B09b 反例：没声明授权变更时，编码、版本、指纹、预置文件任一变化都判红；有声明才放行', () => {
    const same = { codes: ['a/x/op:view'], version: 7, digest: 'd1' };
    const input = (head: Partial<typeof same>, declared: GrantChanges, headFile = 'same') => ({
      base: same,
      head: { ...same, ...head },
      declared,
      files: [{ file: 'presets.ts', base: 'same', head: headFile }],
    });
    const declares: GrantChanges = { reason: '合成授权类变更', add: ['a/y/*'], remove: [] };
    // 没声明：什么都没变才通过
    expect(grantBaselineProblems(input({}, EMPTY_GRANT_CHANGES))).toEqual([]);
    // 没声明但编码多了 / 少了、版本、指纹、预置文件变了：各自判红（不是恒真）
    expect(grantBaselineProblems(input({ codes: ['a/x/op:view', 'a/y/op:view'] }, EMPTY_GRANT_CHANGES))).not.toEqual(
      [],
    );
    expect(grantBaselineProblems(input({ codes: [] }, EMPTY_GRANT_CHANGES))).not.toEqual([]);
    expect(grantBaselineProblems(input({ version: 8 }, EMPTY_GRANT_CHANGES))).not.toEqual([]);
    expect(grantBaselineProblems(input({ digest: 'd2' }, EMPTY_GRANT_CHANGES))).not.toEqual([]);
    expect(grantBaselineProblems(input({}, EMPTY_GRANT_CHANGES, 'changed'))).not.toEqual([]);
    // 有声明：声明覆盖的新增放行，版本 / 指纹 / 预置文件可以变；声明之外的增删仍判红，声明的没发生也判红
    const changed = { codes: ['a/x/op:view', 'a/y/op:view'], version: 8, digest: 'd2' };
    expect(grantBaselineProblems(input(changed, declares, 'changed'))).toEqual([]);
    expect(
      grantBaselineProblems(input({ ...changed, codes: [...changed.codes, 'a/z/op:view'] }, declares)),
    ).not.toEqual([]);
    expect(grantBaselineProblems(input({ version: 8 }, declares))).not.toEqual([]);
  });
});
