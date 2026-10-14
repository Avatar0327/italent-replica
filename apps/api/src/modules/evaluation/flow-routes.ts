/** 管理读取；范围与计数在同一 SQL 谓词上，返回后再按流程对象字段权裁剪。 */
import { isUuid, sql, withTenant } from '@italent/db';
import { EVALUATION_FLOW_OBJECTS } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, trimModuleResponse } from '../permission/module-access.js';
import { objectContext, requestScope } from '../permission/module-route-access.js';
import { pageQuery, uuidParam } from '../talent/http.js';
import { requireFilterVisible, rowsOf } from './access.js';
import { activityPersonSql, registerFlowAudit } from './flow-access.js';
import { view } from './read-model.js';
import { EV_BASE } from './route-support.js';

const OBJECT = EVALUATION_FLOW_OBJECTS.staffEvaluation.code;
const PATH = `${EV_BASE}/staff-evaluations`;
export function registerFlowRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerFlowAudit();
  router.get(PATH, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const page = pageQuery(c);
    const activityId = c.req.query('activityId')?.toLowerCase();
    if (activityId !== undefined && !isUuid(activityId)) throw new AppError('VALIDATION_FAILED', '活动标识不合法');
    if (activityId) requireFilterVisible(await getModuleViewableFields(deps, ctx, OBJECT), 'activityId');
    const filter = sql`e.tenant_id=${ctx.tenantId}::uuid AND ${activityPersonSql(scope)}
      AND (${activityId ?? null}::uuid IS NULL OR e.activity_id=${activityId ?? null}::uuid)`;
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const items = rowsOf<Record<string, unknown>>(
        await tx.execute(sql`SELECT e.* FROM ev_staff_evaluations e
        WHERE ${filter} ORDER BY e.id LIMIT ${page.pageSize} OFFSET ${(page.page - 1) * page.pageSize}`),
      );
      const total = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int n
        FROM ev_staff_evaluations e WHERE ${filter}`),
      )[0]!.n;
      return { items: items.map((row) => view<Record<string, unknown>>(row)), total };
    });
    return c.json({ ...page, total: result.total, items: await trimModuleResponse(deps, ctx, OBJECT, result.items) });
  });
  router.get(`${PATH}/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT);
    const id = uuidParam(c);
    const scope = await requestScope(c, deps, ctx, OBJECT);
    const row = await withTenant(
      deps.db,
      ctx.tenantId,
      async (tx) =>
        rowsOf<Record<string, unknown>>(
          await tx.execute(sql`SELECT e.* FROM ev_staff_evaluations e
        WHERE e.tenant_id=${ctx.tenantId}::uuid AND e.id=${id}::uuid AND ${activityPersonSql(scope)}`),
        )[0],
    );
    if (!row) throw new AppError('NOT_FOUND', '评定数据不存在');
    c.header('ETag', `"${row.revision}"`);
    return c.json((await trimModuleResponse(deps, ctx, OBJECT, [view<Record<string, unknown>>(row)]))[0]);
  });
}
