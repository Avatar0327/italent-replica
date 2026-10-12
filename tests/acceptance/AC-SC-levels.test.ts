import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { buttonResource } from '@italent/domain';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { levelBody, levelKinds, levelsWorld } from './AC-SC-levels-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
describe('AC-SC B2b #11 / #12 风险与健康度等级', () => {
  let w: Awaited<ReturnType<typeof levelsWorld>>;
  beforeAll(async () => {
    w = await levelsWorld(testDb().db);
  });
  it.each(levelKinds)('AC-SC %s：空等级集合重排不制造业务变更', async (kind) => {
    const before = await w.list(kind);
    const response = await w.request('PUT', `/${kind}-levels/order`, { ifMatch: 0, body: { ids: [] } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(await w.list(kind)).toEqual(before);
  });
  it.each(levelKinds)('AC-SC %s：原始行、编译缓存、十进制比例、清空规则和删除快照', async (kind) => {
    const body = levelBody(kind);
    const saved = await w.createLevel(kind, body);
    const path = `/${kind}-levels/${saved.id}`;
    expect(saved).toMatchObject({ revision: 1, color: '#AABBCC', rules: body.rules, compileError: null });
    expect(saved).not.toHaveProperty('compiledFormula');
    const table = sql.identifier(`succession_${kind}_levels`);
    const [cache] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ compiled_formula: string; compiler_version: string }>(
        await tx.execute(sql`SELECT compiled_formula, compiler_version FROM ${table} WHERE id = ${saved.id}::uuid`),
      ),
    );
    expect(cache!.compiled_formula).toContain('>= 0.3');
    expect(cache!.compiler_version).toBeTruthy();
    expect(await (await w.request('GET', path)).json()).toEqual(saved);
    const updated = await w.request('PUT', path, { ifMatch: 1, body: { description: null, rules: null } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({ revision: 2, description: null, rules: null });
    const deletion = { ifMatch: 2, idempotencyKey: randomUUID() };
    expect((await w.request('DELETE', path, deletion)).status).toBe(200);
    expect(await (await w.request('DELETE', path, deletion)).json()).toEqual({ id: saved.id, deleted: true });
    expect((await w.request('GET', path)).status).toBe(404);
    const [audit] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ before: unknown }>(
        await tx.execute(sql`SELECT "before" FROM audit_events WHERE object_id = ${saved.id}
        AND action = ${`succession.${kind}-level.delete`}`),
      ),
    );
    expect(audit!.before).toMatchObject({ id: saved.id, rules: null, revision: 2 });
    expect((await w.request('POST', `/${kind}-levels`, { body })).status).toBe(201);
  });
  it.each(levelKinds)('AC-SC %s：无计算规则也能新增；重复编码／名称、不可改编码、非法行均原子拒绝', async (kind) => {
    const body = { ...levelBody(kind), rules: null };
    const saved = await w.createLevel(kind, body);
    const path = `/${kind}-levels/${saved.id}`;
    for (const duplicate of [
      { ...body, name: randomUUID() },
      { ...body, code: randomUUID() },
    ]) {
      const res = await w.request('POST', `/${kind}-levels`, { body: duplicate });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'LEVEL_DUPLICATE' } } });
    }
    for (const patch of [
      { code: randomUUID() },
      { displayOrder: 99 },
      { rules: { ...levelBody(kind).rules, expression: '1 or 99' } },
      { rules: { ...levelBody(kind).rules, rows: [{ ...levelBody(kind).rules.rows[0], fieldCode: 'unknown' }] } },
      { rules: { ...levelBody(kind).rules, rows: [{ ...levelBody(kind).rules.rows[0], rowNo: 2147483648 }] } },
      {
        rules: {
          ...levelBody(kind).rules,
          rows: Array.from({ length: 51 }, (_, i) => ({
            ...levelBody(kind).rules.rows[0],
            rowNo: i + 1,
          })),
        },
      },
    ]) {
      const rejected = await w.request('PUT', path, { ifMatch: 1, body: patch });
      expect(rejected.status, await rejected.clone().text()).toBe(400);
      expect(await (await w.request('GET', path)).json()).toEqual(saved);
    }
    expect((await w.request('PUT', path, { ifMatch: 99, body: { name: '错误版本' } })).status).toBe(409);
    expect(await (await w.request('GET', path)).json()).toEqual(saved);
    expect((await w.request('GET', `/${kind}-levels/not-a-uuid`)).status).toBe(400);
  });
  it.each(levelKinds)('AC-SC %s：完整集合重排、ETag／集合 CAS、重复／缺项／外租户 ID 不得半写', async (kind) => {
    await w.createLevel(kind);
    const before = await w.list(kind);
    const ids = before.items.map((item) => item.id).reverse();
    const options = { ifMatch: before.collectionRevision, body: { ids }, idempotencyKey: randomUUID() };
    const response = await w.request('PUT', `/${kind}-levels/order`, options);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).items.map((item: { id: string }) => item.id)).toEqual(ids);
    const after = await w.list(kind);
    expect(after.collectionRevision).toBe(before.collectionRevision + 1);
    expect(after.items.map((item) => item.displayOrder)).toEqual(ids.map((_, index) => index + 1));
    expect((await w.request('PUT', `/${kind}-levels/order`, options)).status).toBe(200);
    const badOrders = [ids.slice(1), [...ids, ids[0]], [...ids.slice(1), randomUUID()]];
    for (const bad of badOrders) {
      expect(
        (
          await w.request('PUT', `/${kind}-levels/order`, {
            ifMatch: after.collectionRevision,
            body: { ids: bad },
          })
        ).status,
      ).toBe(400);
      expect(await w.list(kind)).toEqual(after);
    }
    expect(
      (
        await w.request('PUT', `/${kind}-levels/order`, {
          ...options,
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(await w.list(kind)).toEqual(after);
  });
  it('AC-SC 健康度引用人员范围：同租户 RESTRICT，删除条件行后释放引用', async () => {
    const population = await w.create();
    const body = levelBody('health', population.id.toUpperCase());
    const saved = await w.createLevel('health', body);
    const before = await (await w.request('GET', `/populations/${population.id}`)).json();
    const rejected = await w.request('DELETE', `/populations/${population.id}`, { ifMatch: 1 });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'POPULATION_IN_USE' } } });
    expect(await (await w.request('GET', `/populations/${population.id}`)).json()).toEqual(before);
    const other = await seedTenantWithMember(w.db, 'sc-levels-other');
    const foreign = await tenantApi(w.db).request('PUT', `/api/tenant/succession/health-levels/${saved.id}`, {
      tenant: other.tenant.id,
      user: other.user.id,
      ifMatch: 1,
      body: { name: '跨租户' },
    });
    expect(foreign.status).toBe(404);
    const unknown = await w.request('PUT', `/health-levels/${saved.id}`, {
      ifMatch: 1,
      body: { rules: levelBody('health', randomUUID()).rules },
    });
    expect(unknown.status).toBe(404);
    expect((await w.request('PUT', `/health-levels/${saved.id}`, { ifMatch: 1, body: { rules: null } })).status).toBe(
      200,
    );
    expect((await w.request('DELETE', `/populations/${population.id}`, { ifMatch: 1 })).status).toBe(200);
  });
  it('AC-SC 健康度：盘点目录决定过滤类型，多选与非法来源／度量组合拒绝，空阈值给警告', async () => {
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_fields
      (tenant_id, code, name, kind, field_group, precision)
      VALUES (${w.tenant.id}::uuid, 'SC_SCORE', '合成分数', 'number', 'result', 2),
      (${w.tenant.id}::uuid, 'SC_TAGS', '合成标签', 'multi_option', 'basic', NULL)`),
    );
    const row = {
      ...levelBody('health').rules.rows[0]!,
      fieldSource: 'review',
      fieldCode: 'SC_SCORE',
      measure: 'average',
      filterValues: [30],
    };
    const saved = await w.createLevel('health', { ...levelBody('health'), rules: { expression: '1', rows: [row] } });
    for (const bad of [
      { ...row, fieldCode: 'SC_TAGS', measure: 'count' },
      { ...row, measure: 'green_rate' },
      { ...row, fieldSource: 'org', fieldCode: 'person_in_charge_id' },
    ]) {
      const rejected = await w.request('PUT', `/health-levels/${saved.id}`, {
        ifMatch: 1,
        body: { rules: { expression: '1', rows: [bad] } },
      });
      expect(rejected.status).toBe(400);
      expect(await (await w.request('GET', `/health-levels/${saved.id}`)).json()).toEqual(saved);
    }
    const warned = await w.createLevel('risk', {
      ...levelBody('risk'),
      rules: {
        expression: '1',
        rows: [{ ...levelBody('risk').rules.rows[0], threshold: null }],
      },
    });
    expect(warned).toMatchObject({ warnings: [{ code: 'RULE_ROW_VALUE_MISSING', rowNo: 1 }] });
  });
  it.each(levelKinds)('AC-SC %s：首次、直接重放、提交确认丢失回查均只写一次', async (kind) => {
    const saved = await w.createLevel(kind);
    const path = `/${kind}-levels/${saved.id}`;
    const options = { ifMatch: 1, body: { name: randomUUID() }, idempotencyKey: randomUUID() };
    const transaction = w.db.transaction.bind(w.db);
    let lost = false;
    const spy = vi.spyOn(w.db, 'transaction').mockImplementation(async (callback, config) => {
      const result = await transaction(callback, config);
      if (!lost && result && typeof result === 'object' && 'status' in result) {
        lost = true;
        throw new Error('合成提交确认丢失');
      }
      return result;
    });
    try {
      const response = await w.request('PUT', path, options);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(lost).toBe(true);
      const view = await response.json();
      expect(view).toMatchObject({ revision: 2, name: options.body.name });
      expect(await (await w.request('PUT', path, options)).json()).toEqual(view);
    } finally {
      spy.mockRestore();
    }
    const [audit] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE command_id = ${options.idempotencyKey}
        AND action = ${`succession.${kind}-level.update`}`),
      ),
    );
    expect(audit!.n).toBe(1);
  });
  it.each(levelKinds)('AC-SC %s：options 仅启用等级和五个安全键，缺 assign／reset 按钮为 403', async (kind) => {
    const saved = await w.createLevel(kind);
    const response = await w.request('GET', `/${kind}-levels/options`);
    expect(response.status).toBe(200);
    const items = (await response.json()).items;
    expect(items.find((item: { id: string }) => item.id === saved.id)).toEqual({
      id: saved.id,
      code: saved.code,
      name: saved.name,
      color: saved.color,
      enabled: true,
    });
    expect(
      (await w.request('PUT', `/${kind}-levels/${saved.id}`, { ifMatch: 1, body: { enabled: false } })).status,
    ).toBe(200);
    expect(
      (await (await w.request('GET', `/${kind}-levels/options`)).json()).items.some(
        (item: { id: string }) => item.id === saved.id,
      ),
    ).toBe(false);
    const api = tenantApi(w.db, { authorize: (request) => request.action !== 'object.button' });
    expect((await api.request('GET', `/api/tenant/succession/${kind}-levels/options`, w.asAdmin)).status).toBe(403);
    const resetOnly = tenantApi(w.db, {
      authorize: (request) =>
        request.action !== 'object.button' ||
        request.resource === buttonResource('Succession.HealthResult', 'reset', 'list'),
    });
    expect((await resetOnly.request('GET', '/api/tenant/succession/health-levels/options', w.asAdmin)).status).toBe(
      200,
    );
  });
});
