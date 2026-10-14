/** #10 / §8.4：SQL 可见性先于分页；读、重试与审计共用逐对象谓词。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate, renderRuleFailureText, type FailureCode } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { requirePermission } from '../../authorization.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import { codeOf, type SuccessionContext } from './access.js';
import { rowsOf } from './read-sql.js';
import type { ResultAdapter } from './write-support.js';

/** o 为冻结对象；范围按请求当日职位归属 / 员工范围判定，不用 run 业务日反推权限。 */
export function calcObjectVisible(scope: ModuleScope, tenantId: string, today: string | SQL): SQL {
  const creator = sql`(SELECT requested_by FROM succession_calc_runs cr
    WHERE cr.tenant_id=o.tenant_id AND cr.id=o.run_id)`;
  const positionOrg = sql`(SELECT CASE WHEN v.stop_date>=${today}::date THEN v.org_id END FROM job_position_versions v
    WHERE v.tenant_id=${tenantId}::uuid AND v.object_id=o.object_id AND v.start_date<=${today}::date
    ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1)`;
  return sql`COALESCE(CASE o.object_type
    WHEN 'org' THEN ${scopeSql(scope, { org: sql`o.object_id`, creator })}
    WHEN 'position' THEN ${scopeSql(scope, { org: positionOrg, creator })}
    WHEN 'employee' THEN ${scopeSql(scope, { person: sql`o.object_id`, creator })}
    ELSE false END,false)`;
}
export function calcRowsVisible(scope: ModuleScope, tenantId: string, runId: SQL, today: string | SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM succession_calc_run_objects o
    WHERE o.tenant_id=${tenantId}::uuid AND o.run_id::text=${runId}::text
    AND ${calcObjectVisible(scope, tenantId, today)})`;
}
export interface CalcView {
  readonly id: string;
  readonly revision: number;
  readonly kind: string;
  readonly trigger: string;
  readonly status: string;
  readonly requestedBy: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly visibleCounts: Record<string, number>;
  readonly scope?: unknown;
}
export async function calcAccess(tx: Tx, deps: TenantRouteDeps, ctx: SuccessionContext) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  await requirePermission(bound.authorize, { ...ctx, action: 'object.view', resource: codeOf('calcRun'), fields: [] });
  return resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('calcRun'));
}
const missing = () => new AppError('NOT_FOUND', '计算任务不存在');
function whole(scope: ModuleScope, ctx: SuccessionContext): SQL {
  return sql`(r.requested_by=${ctx.userId}::uuid OR ${scope.all && scope.source === 'identity'}
    OR ${calcRowsVisible(scope, ctx.tenantId, sql`r.id`, tenantLocalDate(ctx.now, ctx.timezone))})`;
}
export async function readCalcRuns(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  page: { limit: number; offset: number },
  ids?: readonly string[],
) {
  const scope = await calcAccess(tx, deps, ctx);
  const where = sql`r.tenant_id=${ctx.tenantId}::uuid AND ${whole(scope, ctx)}
    ${ids ? sql`AND r.id=ANY(${`{${ids.join(',')}}`}::uuid[])` : sql``}`;
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`
    SELECT count(*)::int total FROM succession_calc_runs r WHERE ${where}`),
  );
  const rows = rowsOf<Omit<CalcView, 'visibleCounts'>>(
    await tx.execute(sql`
    SELECT r.id,r.revision,r.kind,r.trigger,r.status,r.requested_by AS "requestedBy",
    r.started_at AS "startedAt",r.finished_at AS "finishedAt",r.scope
    FROM succession_calc_runs r WHERE ${where} ORDER BY r.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  if (ids && rows.length !== ids.length) throw missing();
  const views: CalcView[] = [];
  for (const row of rows) {
    const groups = rowsOf<{ outcome: string; n: number }>(
      await tx.execute(sql`
      SELECT COALESCE(o.outcome,'pending') outcome,count(*)::int n FROM succession_calc_run_objects o
      WHERE o.tenant_id=${ctx.tenantId}::uuid AND o.run_id=${row.id}::uuid
      AND ${calcObjectVisible(scope, ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))} GROUP BY o.outcome`),
    );
    const visibleCounts = {
      total: 0,
      pending: 0,
      written: 0,
      unchanged: 0,
      manual_kept: 0,
      failed: 0,
      revision_conflict: 0,
    } as Record<string, number>;
    for (const group of groups) {
      visibleCounts[group.outcome] = group.n;
      visibleCounts.total! += group.n;
    }
    const { scope: frozen, ...rest } = row;
    views.push({ ...rest, visibleCounts, ...(scope.all && scope.source === 'identity' ? { scope: frozen } : {}) });
  }
  return { views, total: count!.total };
}
export async function projectCalc(deps: TenantRouteDeps, ctx: SuccessionContext, views: readonly CalcView[]) {
  const fields = await getModuleViewableFields(deps, ctx, codeOf('calcRun'));
  return views.map((view) =>
    fields === undefined
      ? view
      : (Object.fromEntries(
          Object.entries(view).filter(([key]) => key === 'scope' || fields.has(key)),
        ) as Partial<CalcView>),
  );
}
export const calcResults: ResultAdapter<CalcView> = {
  object: 'calcRun',
  async load(tx, deps, ctx, ids) {
    const { views } = await readCalcRuns(tx, deps, ctx, { limit: ids.length || 1, offset: 0 }, ids);
    return { views, revisions: new Map(views.map((view) => [view.id, view.revision])) };
  },
  project: projectCalc,
};
export async function readCalcFailures(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  id: string,
  page: { limit: number; offset: number },
) {
  const scope = await calcAccess(tx, deps, ctx);
  await readCalcRuns(tx, deps, ctx, { limit: 1, offset: 0 }, [id]);
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('calcRun'), tx);
  if (fields && !fields.has('failures')) return { items: [] };
  const source = sql`FROM succession_calc_run_failures f JOIN succession_calc_run_objects o
    ON o.tenant_id=f.tenant_id AND o.run_id=f.run_id AND o.object_id=f.object_id AND o.object_type=f.object_type
    WHERE f.tenant_id=${ctx.tenantId}::uuid AND f.run_id=${id}::uuid
    AND ${calcObjectVisible(scope, ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))}`;
  const [count] = rowsOf<{ total: number }>(await tx.execute(sql`SELECT count(*)::int total ${source}`));
  const items = rowsOf<{ code: FailureCode; rowNo: number | null } & Record<string, unknown>>(
    await tx.execute(sql`SELECT f.object_type AS "objectType", f.object_id AS "objectId",
    f.code, f.level_id AS "levelId", f.row_no AS "rowNo" ${source}
    ORDER BY f.object_id,f.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return {
    items: items.map((item) => ({ ...item, message: renderRuleFailureText(item.code, item.rowNo ?? undefined) })),
    total: count!.total,
  };
}
/** 调用方先持 run 行锁，worker 等待期间不能改变这里判定的实际执行集合。 */
export async function requireCalcRetryScope(tx: Tx, deps: TenantRouteDeps, ctx: SuccessionContext, id: string) {
  const scope = await calcAccess(tx, deps, ctx);
  await readCalcRuns(tx, deps, ctx, { limit: 1, offset: 0 }, [id]);
  const outside = rowsOf(
    await tx.execute(sql`SELECT 1 FROM succession_calc_run_objects o
    WHERE o.tenant_id=${ctx.tenantId}::uuid AND o.run_id=${id}::uuid AND (o.outcome IS NULL OR o.retryable)
    AND NOT (${calcObjectVisible(scope, ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))}) LIMIT 1`),
  );
  if (outside.length)
    throw new AppError('FORBIDDEN', '执行集合超出当前范围', { reason: 'RUN_SCOPE_EXCEEDS_REQUESTER' });
}
