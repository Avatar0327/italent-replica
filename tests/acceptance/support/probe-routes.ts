/**
 * 测试专用的租户路由：在组织对象（R1-T03）落地前，用 tenant_probe 夹具验证
 * “租户中间件 + withTenant + RLS”整条链路对带 ID 对象的读 / 改 / 删。
 * 他租户对象一律 404（与不存在无法区分，docs/08_设计/R1-T00 §4）。
 */
import { AppError, tenantOf, type TenantRouteModule } from '@italent/api';
import { withTenant } from '@italent/db';
import { tenantProbe } from '@italent/testkit';
import { eq } from 'drizzle-orm';

const notFound = () => new AppError('NOT_FOUND', '对象不存在');

export const probeRoutes: TenantRouteModule = (router, { db }) => {
  router.get('/api/tenant/probes', async (c) => {
    const rows = await withTenant(db, tenantOf(c).tenantId, (tx) => tx.select().from(tenantProbe));
    return c.json({ items: rows });
  });

  router.post('/api/tenant/probes', async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    const { tenantId } = tenantOf(c);
    const [row] = await withTenant(db, tenantId, (tx) =>
      tx.insert(tenantProbe).values({ tenantId, name }).returning(),
    );
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
