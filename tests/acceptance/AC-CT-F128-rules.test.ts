/** F-128 BE-1：续签规则删除与分页（A16）。执行记录、命中预览不在本行。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { tenantApi } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import type { Authorizer } from '@italent/api';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;

async function addRule(w: World, priority: number) {
  const response = await w.request('POST', '/rules', {
    ifMatch: 0,
    body: {
      name: `规则${priority}`,
      priority,
      orgIds: [w.org.id],
      personIds: [],
      details: [{ typeId: w.type.id, months: 12, initiatorId: w.session.user.id, daysBefore: 10, skipTypeIds: [] }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}
async function listRules(w: World, qs = '') {
  const response = await w.request('GET', `/rules${qs}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { items: { id: string; priority: number }[]; total: number };
}

describe('AC-CT F-128 A16 规则删除与分页', () => {
  it('DELETE /rules/:id 校验 revision、同事务审计，删除后规则与明细都不在', async () => {
    const w = await contractWorld(testDb().db, 'f128-rule-delete');
    const rule = await addRule(w, 1);
    const kept = await addRule(w, 2);
    expect((await w.request('DELETE', `/rules/${rule.id}`, { ifMatch: rule.revision + 5 })).status).toBe(409);
    expect((await w.request('DELETE', `/rules/${rule.id}`)).status).toBe(400);
    const deleted = await w.request('DELETE', `/rules/${rule.id}`, { ifMatch: rule.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toEqual({ id: rule.id, deleted: true });
    expect((await listRules(w)).items.map((r) => r.id)).toEqual([kept.id]);
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const details = rowsOf(
        await tx.execute(sql`SELECT 1 FROM contract_renewal_details WHERE rule_id=${rule.id}::uuid`),
      );
      expect(details).toHaveLength(0);
      const audit = rowsOf(
        await tx.execute(sql`SELECT 1 FROM audit_events WHERE object_id=${rule.id} AND action='contract.rules.delete'`),
      );
      expect(audit).toHaveLength(1);
    });
  });

  it('删除回执 { id, deleted: true } 不被字段裁剪移除（查看字段受限时亦然）', async () => {
    const w = await contractWorld(testDb().db, 'f128-rule-receipt');
    const rule = await addRule(w, 1);
    const authorize: Authorizer = (request) => request.action !== 'data.scope.all';
    registerScopeProvider(authorize, {
      scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true }),
      authorize: async (request) => Boolean(await authorize(request)),
      fields: async () => new Set(['name']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
    const response = await api.request('DELETE', `/api/tenant/contracts/rules/${rule.id}`, {
      tenant: w.session.tenant.id,
      user: w.session.user.id,
      ifMatch: rule.revision,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ id: rule.id, deleted: true });
  });

  it('同一命令 ID 重放不重复删除；已删除的规则再删 → 404；非法 ID → 400', async () => {
    const w = await contractWorld(testDb().db, 'f128-rule-delete-replay');
    const rule = await addRule(w, 1);
    const first = await w.request('DELETE', `/rules/${rule.id}`, { ifMatch: rule.revision, idempotencyKey: 'del-1' });
    const replay = await w.request('DELETE', `/rules/${rule.id}`, { ifMatch: rule.revision, idempotencyKey: 'del-1' });
    expect([first.status, replay.status]).toEqual([200, 200]);
    expect((await w.request('DELETE', `/rules/${rule.id}`, { ifMatch: rule.revision })).status).toBe(404);
    expect((await w.request('DELETE', '/rules/not-a-uuid', { ifMatch: 1 })).status).toBe(400);
  });

  it('GET /rules 支持分页并返回 total，按优先级排序', async () => {
    const w = await contractWorld(testDb().db, 'f128-rule-page');
    for (const priority of [3, 1, 2]) await addRule(w, priority);
    const first = await listRules(w, '?page=1&pageSize=2');
    expect(first.items.map((r) => r.priority)).toEqual([1, 2]);
    expect(first.total).toBe(3);
    const second = await listRules(w, '?page=2&pageSize=2');
    expect(second.items.map((r) => r.priority)).toEqual([3]);
    expect(second.total).toBe(3);
  });
});
