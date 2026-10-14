/** §8.4：SQL 逐目标范围与 SELF 先于分页；批次、明细、计数和审计共用谓词。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  scopeSql,
  type ModuleScope,
} from '../permission/module-access.js';
import { codeOf, type SuccessionContext } from './access.js';
import { rowsOf, selfRecordHiddenSql } from './read-sql.js';
import type { ResultAdapter } from './write-support.js';
export function syncTargetVisible(
  scope: ModuleScope,
  viewer: { tenantId: string; userId: string },
  kind: SQL,
  id: SQL,
  today: string | SQL,
): SQL {
  const org = sql`CASE WHEN ${kind}='position' THEN (SELECT v.org_id FROM job_position_versions v
    WHERE v.tenant_id=${viewer.tenantId}::uuid AND v.object_id=${id} AND v.start_date<=${today}::date
    ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1) ELSE ${id} END`;
  const hidden = selfRecordHiddenSql(
    viewer,
    {
      type: sql`CASE WHEN ${kind}='position' THEN 'position' ELSE 'org' END`,
      org: sql`CASE WHEN ${kind}<>'position' THEN ${id} END`,
      position: sql`CASE WHEN ${kind}='position' THEN ${id} END`,
    },
    today,
  );
  return sql`(${scopeSql(scope, { org })} AND NOT ${hidden})`;
}
export function syncRowsVisible(
  scope: ModuleScope,
  viewer: { tenantId: string; userId: string },
  id: SQL,
  today: string | SQL,
) {
  return sql`EXISTS (SELECT 1 FROM (
    SELECT target_kind AS kind,target_id,batch_id,tenant_id FROM succession_sync_targets
    UNION ALL SELECT kind,coalesce(target_org_id,target_position_id),batch_id,tenant_id FROM succession_sync_items
    ) t WHERE t.tenant_id=${viewer.tenantId}::uuid AND t.batch_id::text=${id}::text
    AND ${syncTargetVisible(scope, viewer, sql`t.kind`, sql`t.target_id`, today)})`;
}
export async function syncAdmin(tx: Tx, ctx: Pick<SuccessionContext, 'tenantId' | 'userId'>) {
  return (
    rowsOf(
      await tx.execute(sql`SELECT 1 FROM permission_grants g JOIN permission_profiles p
    ON p.tenant_id=g.tenant_id AND p.id=g.profile_id WHERE g.tenant_id=${ctx.tenantId}::uuid
    AND g.user_id=${ctx.userId}::uuid AND g.status='active' AND p.source='standard'
    AND p.code='standard_succession_admin' LIMIT 1`),
    ).length > 0
  );
}
async function access(tx: Tx, deps: TenantRouteDeps, ctx: SuccessionContext) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  await requirePermission(bound.authorize, {
    ...ctx,
    action: 'object.view',
    resource: codeOf('syncBatch'),
    fields: [],
  });
  return resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('syncBatch'));
}
export interface BatchView extends Record<string, unknown> {
  id: string;
  revision: number;
}
export async function readSync(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  page: { limit: number; offset: number },
  ids?: readonly string[],
) {
  const scope = await access(tx, deps, ctx),
    today = tenantLocalDate(ctx.now, ctx.timezone);
  const admin = await syncAdmin(tx, ctx);
  const where = sql`b.tenant_id=${ctx.tenantId}::uuid AND (b.actor_user_id=${ctx.userId}::uuid
    OR ${admin && scope.all && scope.source === 'identity'} OR ${syncRowsVisible(scope, ctx, sql`b.id`, today)})
    ${ids ? sql`AND b.id=ANY(${`{${ids.join(',')}}`}::uuid[])` : sql``}`;
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*)::int total FROM succession_sync_batches b WHERE ${where}`),
  );
  const views = rowsOf<BatchView>(
    await tx.execute(sql`SELECT b.id,b.revision,b.project_id AS "projectId",
    b.meeting_id AS "meetingId",b.trigger,b.strategy,b.status,b.result,b.actor_user_id AS "actorUserId",
    b.block_reason AS "blockReason",b.end_reason AS "endReason",b.has_plan AS "hasPlan",
    b.source_principal_user_id AS "sourcePrincipalUserId",b.write_principal_user_id AS "writePrincipalUserId"
    FROM succession_sync_batches b WHERE ${where} ORDER BY b.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  if (ids && views.length !== ids.length) throw new AppError('NOT_FOUND', '同步批次不存在');
  for (const view of views) {
    if (!admin) {
      delete view.sourcePrincipalUserId;
      delete view.writePrincipalUserId;
    }
    const counts: Record<string, number> = {};
    for (const kind of ['items', 'targets'] as const) {
      const { source } = rowSource(scope, ctx, view.id, kind);
      const [n] = rowsOf<{ total: number }>(await tx.execute(sql`SELECT count(*)::int total ${source}`));
      counts[kind] = n!.total;
    }
    view.visibleCounts = counts;
  }
  return { views, total: count!.total };
}
function rowSource(scope: ModuleScope, ctx: SuccessionContext, id: string, kind: 'items' | 'targets') {
  const items = kind === 'items';
  const visible = syncTargetVisible(
    scope,
    ctx,
    items ? sql`r.kind` : sql`r.target_kind`,
    items ? sql`coalesce(r.target_org_id,r.target_position_id)` : sql`r.target_id`,
    tenantLocalDate(ctx.now, ctx.timezone),
  );
  return {
    source: sql`FROM ${sql.identifier(`succession_sync_${kind}`)} r
    WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.batch_id=${id}::uuid AND ${visible}`,
  };
}
export async function readSyncRows(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  id: string,
  kind: 'items' | 'targets',
  page: { limit: number; offset: number },
) {
  await readSync(tx, deps, ctx, { limit: 1, offset: 0 }, [id]);
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('syncBatch'), tx);
  if (fields && !fields.has(kind)) return { items: [] };
  const scope = await access(tx, deps, ctx),
    { source } = rowSource(scope, ctx, id, kind);
  const [count] = rowsOf<{ total: number }>(await tx.execute(sql`SELECT count(*)::int total ${source}`));
  const projection =
    kind === 'items'
      ? sql`r.nomination_id AS "nominationId",r.kind,r.target_org_id AS "targetOrgId",
      r.target_position_id AS "targetPositionId",r.successor_employee_id AS "successorEmployeeId",
      r.plan_outcome AS "planOutcome",r.exec_outcome AS "execOutcome"`
      : sql`r.target_kind AS "targetKind",r.target_id AS "targetId",r.status,r.action`;
  const items = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT r.id,r.error_code AS "errorCode",
    r.retryable,${projection} ${source} ORDER BY r.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const recordFields = await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('record'), tx);
  if (recordFields && !recordFields.has('successorEmployeeId'))
    for (const item of items) delete item.successorEmployeeId;
  return {
    items: items.map(({ retryable, ...item }) => ({
      ...item,
      recovery: retryable === true ? 'retry_same_run' : 'none',
    })),
    total: count!.total,
  };
}
export async function projectSync(deps: TenantRouteDeps, ctx: SuccessionContext, views: readonly BatchView[]) {
  const fields = await getModuleViewableFields(deps, ctx, codeOf('syncBatch'));
  return views.map((view) =>
    fields === undefined
      ? view
      : Object.fromEntries(Object.entries(view).filter(([key]) => ['id', 'revision'].includes(key) || fields.has(key))),
  );
}
export const syncResults: ResultAdapter<BatchView> = {
  object: 'syncBatch',
  project: projectSync,
  async load(tx, deps, ctx, ids) {
    const { views } = await readSync(tx, deps, ctx, { limit: ids.length || 1, offset: 0 }, ids);
    return { views, revisions: new Map(views.map((v) => [v.id, v.revision])) };
  },
};
