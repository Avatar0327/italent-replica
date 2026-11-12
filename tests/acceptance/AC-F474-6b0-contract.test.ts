import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import * as presets from '../../apps/api/src/route-policy/presets.js';
import * as catalog from '../../apps/api/src/modules/permission/tenant-catalog.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { resultRows } from './AC-ORG-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const base = '/api/tenant/employment/custom-fields';
const types = ['text', 'integer', 'decimal', 'boolean', 'date'];
const input = { name: '合成字段', objectType: 'employment', valueType: 'text' };

async function seedDefinition(tenantId: string, objectType: string, valueType = 'text') {
  const id = randomUUID();
  await withTenant(database().db, tenantId, (tx) =>
    tx.execute(sql`
    INSERT INTO employment_custom_field_objects(id, tenant_id, code, name, object_type, value_type)
    VALUES (${id}, ${tenantId}, ${id}, '合成扩展字段', ${objectType}, ${valueType})
  `),
  );
  return id;
}

describe('AC-F474-6b0 收窄的自定义字段共享契约', () => {
  it('AC-F474-01 四种对象各支持五种类型，组织和人员定义可查询且按租户隔离', async () => {
    const a = await seedPermissionWorld(database().db);
    const b = await seedPermissionWorld(database().db);
    for (const objectType of ['employment', 'contract', 'organization', 'personnel']) {
      const ids = [];
      for (const valueType of types) ids.push(await seedDefinition(a.tenant.id, objectType, valueType));
      const response = await a.api.request('GET', `${base}?objectType=${objectType}`, a.asAdmin);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((row: { id: string }) => row.id).sort()).toEqual(ids.sort());
      expect(body.items.map((row: { valueType: string }) => row.valueType).sort()).toEqual([...types].sort());
      const foreign = await b.api.request('GET', `${base}?objectType=${objectType}`, b.asAdmin);
      expect(foreign.status).toBe(200);
      expect((await foreign.json()).items).toEqual([]);
    }
    expect((await a.api.request('GET', `${base}?objectType=unknown`, a.asAdmin)).status).toBe(400);
  });

  it('AC-F474-02 DEC-896 组织人员可创建，继承设置不能写入这两类定义', async () => {
    const w = await seedPermissionWorld(database().db);
    for (const objectType of ['organization', 'personnel']) {
      const create = await w.api.request('POST', base, { ...w.asAdmin, ifMatch: 0, body: { ...input, objectType } });
      expect(create.status).toBe(201);
      const id = await seedDefinition(w.tenant.id, objectType);
      const change = await w.api.request('PUT', `${base}/${id}/inheritance`, {
        ...w.asAdmin,
        ifMatch: 1,
        body: { inherit: false },
      });
      expect(change.status).toBe(400);
      const state = await withTenant(w.db, w.tenant.id, async (tx) => ({
        head: resultRows(await tx.execute(sql`SELECT revision FROM employment_custom_field_objects WHERE id=${id}`)),
        versions: resultRows(
          await tx.execute(sql`SELECT id FROM employment_custom_field_inheritance_versions WHERE field_id=${id}`),
        ),
      }));
      expect(state).toEqual({ head: [{ revision: 1 }], versions: [] });
    }
  });

  it('AC-F474-03 现有五种类型创建、继承变更、冲突与幂等沿用真实管理员授权', async () => {
    const w = await seedPermissionWorld(database().db);
    for (const objectType of ['employment', 'contract']) {
      for (const valueType of types) {
        const idempotencyKey = randomUUID();
        const options = { ...w.asAdmin, ifMatch: 0, idempotencyKey, body: { ...input, objectType, valueType } };
        const created = await w.api.request('POST', base, options);
        expect(created.status).toBe(201);
        const row = await created.json();
        expect(await (await w.api.request('POST', base, options)).json()).toEqual(row);
        const updated = await w.api.request('PUT', `${base}/${row.id}/inheritance`, {
          ...w.asAdmin,
          ifMatch: 1,
          body: { inherit: false },
        });
        expect(updated.status).toBe(200);
        expect(await updated.json()).toMatchObject({ id: row.id, inherit: false, revision: 2 });
        const stale = await w.api.request('PUT', `${base}/${row.id}/inheritance`, {
          ...w.asAdmin,
          ifMatch: 1,
          body: { inherit: true },
        });
        expect(stale.status).toBe(409);
      }
    }
    for (const body of [
      { ...input, valueType: 'select' },
      { ...input, options: [] },
    ]) {
      expect((await w.api.request('POST', base, { ...w.asAdmin, ifMatch: 0, body })).status).toBe(400);
    }
  });

  it('AC-F474-04 专用触发器保护元数据，列级授权与元数据保护都生效', async () => {
    const w = await seedPermissionWorld(database().db);
    const id = await seedDefinition(w.tenant.id, 'employment');
    const trigger = resultRows<{ name: string }>(
      await w.db.execute(sql`
      SELECT p.proname AS name FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgname='employment_custom_field_objects_metadata_only'
    `),
    );
    expect(trigger).toEqual([{ name: 'protect_employment_custom_field_metadata' }]);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      UPDATE employment_custom_field_objects SET revision=2 WHERE id=${id}
    `),
    );
    for (const assignment of [
      "name='禁止覆盖'",
      "object_type='contract'",
      "value_type='integer'",
      "code='changed'",
      `id='${randomUUID()}'`,
      `tenant_id='${randomUUID()}'`,
      "created_at=now() + interval '1 day'",
    ]) {
      const statement = sql`UPDATE employment_custom_field_objects SET ${sql.raw(assignment)} WHERE id=${id}`;
      const denied = await withTenant(w.db, w.tenant.id, (tx) => tx.execute(statement)).catch((e: unknown) => e);
      expect(pgErrorCode(denied)).toBe('42501');
      const protectedMetadata = await withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(sql`RESET ROLE`);
        await tx.execute(statement);
      }).catch((e: unknown) => e);
      expect(pgErrorCode(protectedMetadata)).toBe('55000');
    }
    for (const statement of [
      sql`DELETE FROM employment_custom_field_objects WHERE id=${id}`,
      sql`TRUNCATE employment_custom_field_objects CASCADE`,
    ]) {
      const error = await withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(sql`RESET ROLE`);
        await tx.execute(statement);
      }).catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe('55000');
    }
    const unchanged = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      SELECT revision, name FROM employment_custom_field_objects WHERE id=${id}
    `),
    );
    expect(resultRows(unchanged)).toEqual([{ revision: 2, name: '合成扩展字段' }]);
  });

  it('AC-F474-05 租户字段来源提供组织人员的 custom:id，不混入另一对象或租户', async () => {
    const w = await seedPermissionWorld(database().db);
    const id = await seedDefinition(w.tenant.id, 'organization');
    await seedDefinition(w.tenant.id, 'personnel');
    const source = (catalog as Record<string, unknown>).customFields as (
      objectType: string,
    ) => catalog.TenantFieldSource;
    expect(source).toBeTypeOf('function');
    expect(await withTenant(w.db, w.tenant.id, (tx) => source('organization')(tx, 201))).toEqual([`custom:${id}`]);
  });

  it('AC-F474-06 正文加自定义字段声明保留写足迹、返回守卫和控制字段', () => {
    const helper = (presets as Record<string, unknown>).customFieldsWrite as (
      footprint: string,
      result: string,
      extra: object,
    ) => unknown;
    expect(helper).toBeTypeOf('function');
    expect(helper('org.result', 'org.result', { controls: ['confirmed'] })).toEqual({
      fields: 'body+customFields',
      footprint: 'org.result',
      result: 'org.result',
      controls: ['confirmed'],
    });
  });

  it('AC-F474-07 创建在命令内按同一判定复核，撤权时不落定义和成功审计', async () => {
    const w = await seedPermissionWorld(database().db);
    let checks = 0;
    const api = tenantApi(w.db, { authorize: ({ action }) => action !== 'object.create' || ++checks === 1 });
    const command = randomUUID();
    const response = await api.request('POST', base, {
      ...w.asAdmin,
      ifMatch: 0,
      idempotencyKey: command,
      body: input,
    });
    expect(response.status).toBe(403);
    const state = await withTenant(w.db, w.tenant.id, async (tx) => ({
      fields: resultRows(await tx.execute(sql`SELECT id FROM employment_custom_field_objects`)),
      audit: resultRows(
        await tx.execute(
          sql`SELECT id FROM audit_events WHERE command_id=${command} AND action='employment.custom_field.create'`,
        ),
      ),
    }));
    expect(state).toEqual({ fields: [], audit: [] });
  });
  it('AC-F474-08 每对象 200 上限独立计数，失败无新增审计，另一租户可创建', async () => {
    const w = await seedPermissionWorld(database().db);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      INSERT INTO employment_custom_field_objects(tenant_id, code, name, object_type, value_type)
      SELECT ${w.tenant.id}, 'limit-' || i, '合成上限字段', 'employment', 'text' FROM generate_series(1,200) i
    `),
    );
    const command = randomUUID();
    const blocked = await w.api.request('POST', base, {
      ...w.asAdmin,
      ifMatch: 0,
      idempotencyKey: command,
      body: input,
    });
    expect(blocked.status).toBe(503);
    const state = await withTenant(w.db, w.tenant.id, async (tx) => ({
      count: resultRows(await tx.execute(sql`SELECT count(*)::int AS n FROM employment_custom_field_objects`)),
      audits: resultRows(
        await tx.execute(sql`SELECT id FROM audit_events WHERE command_id=${command}
        AND action='employment.custom_field.create'`),
      ),
    }));
    expect(state).toEqual({ count: [{ n: 200 }], audits: [] });
    const other = await seedPermissionWorld(database().db);
    expect((await other.api.request('POST', base, { ...other.asAdmin, ifMatch: 0, body: input })).status).toBe(201);
    expect(
      (
        await w.api.request('POST', base, {
          ...w.asAdmin,
          ifMatch: 0,
          body: { ...input, objectType: 'contract' },
        })
      ).status,
    ).toBe(201);
  });

  it('AC-F474-09 跨租户更新影响零行，其余头表仍绑定共用保护器', async () => {
    const w = await seedPermissionWorld(database().db);
    const other = await seedPermissionWorld(database().db);
    const id = await seedDefinition(w.tenant.id, 'employment');
    const changed = await withTenant(w.db, other.tenant.id, (tx) =>
      tx.execute(sql`
      UPDATE employment_custom_field_objects SET revision=2 WHERE id=${id} RETURNING id
    `),
    );
    expect(resultRows(changed)).toEqual([]);
    const names = resultRows(
      await w.db.execute(sql`
      SELECT p.proname AS name FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgname IN ('employment_employees_metadata_only',
        'employment_business_objects_metadata_only', 'employment_settings_metadata_only')
    `),
    );
    expect(names).toEqual(Array.from({ length: 3 }, () => ({ name: 'protect_employment_head_metadata' })));
    for (const valueType of ['select', 'unknown']) {
      const error = await seedDefinition(w.tenant.id, 'employment', valueType).catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe('23514');
    }
    const unchanged = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`
      SELECT revision FROM employment_custom_field_objects WHERE id=${id}
    `),
    );
    expect(resultRows(unchanged)).toEqual([{ revision: 1 }]);
  });
});
