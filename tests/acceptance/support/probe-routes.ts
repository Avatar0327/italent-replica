/**
 * 测试专用的租户路由：在组织对象（R1-T03）落地前，用 tenant_probe 夹具验证
 * “租户中间件 + withTenant + RLS”整条链路对带 ID 对象的读 / 改 / 删。
 * 他租户对象一律 404（与不存在无法区分，docs/08_设计/R1-T00 §4）。
 */
import { AppError, defineTable, type RoutePolicy, tenantOf, type TenantRouteModule } from '@italent/api';
import { eq, withTenant } from '@italent/db';
import { tenantProbe } from '@italent/testkit';

const notFound = () => new AppError('NOT_FOUND', '对象不存在');

const fixture: RoutePolicy = { kind: 'member', reason: '测试夹具', fields: { mode: 'none', reason: '测试夹具' } };
const fixtureNone = { none: true as const, reason: '测试夹具' };
const fixtureWrite = { write: { fields: 'body' as const, footprint: fixtureNone, result: fixtureNone } };
/** 夹具路由的声明（F-039）：createApp 要求每条注册都有声明，测试经 routePolicies 传入。 */
export const PROBE_POLICY_ENTRIES: Readonly<Record<string, RoutePolicy>> = {
  'GET /api/tenant/probes': fixture,
  'POST /api/tenant/probes': { ...fixture, ...fixtureWrite },
  'GET /api/tenant/probes/:id': fixture,
  'PUT /api/tenant/probes/:id': { ...fixture, ...fixtureWrite },
  'DELETE /api/tenant/probes/:id': { ...fixture, ...fixtureWrite },
};
export const PROBE_POLICIES = defineTable('probe', PROBE_POLICY_ENTRIES);

export const probeRoutes: TenantRouteModule = (router, { db }) => {
  router.get('/api/tenant/probes', async (c) => {
    const rows = await withTenant(db, tenantOf(c).tenantId, (tx) => tx.select().from(tenantProbe));
    return c.json({ items: rows });
  });

  router.post('/api/tenant/probes', async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    const { tenantId } = tenantOf(c);
    const [row] = await withTenant(db, tenantId, (tx) => tx.insert(tenantProbe).values({ tenantId, name }).returning());
    return c.json(row, 201);
  });

  router.get('/api/tenant/probes/:id', async (c) => {
    const id = c.req.param('id');
    const [row] = await withTenant(db, tenantOf(c).tenantId, (tx) =>
      tx.select().from(tenantProbe).where(eq(tenantProbe.id, id)),
    );
    if (!row) throw notFound();
    return c.json(row);
  });

  router.put('/api/tenant/probes/:id', async (c) => {
    const id = c.req.param('id');
    const { name } = await c.req.json<{ name: string }>();
    const rows = await withTenant(db, tenantOf(c).tenantId, (tx) =>
      tx.update(tenantProbe).set({ name }).where(eq(tenantProbe.id, id)).returning(),
    );
    if (rows.length === 0) throw notFound();
    return c.json(rows[0]);
  });

  router.delete('/api/tenant/probes/:id', async (c) => {
    const id = c.req.param('id');
    const rows = await withTenant(db, tenantOf(c).tenantId, (tx) =>
      tx.delete(tenantProbe).where(eq(tenantProbe.id, id)).returning(),
    );
    if (rows.length === 0) throw notFound();
    return c.body(null, 204);
  });
};
