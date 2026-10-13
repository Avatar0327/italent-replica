/** #15 / §7：组织设置 → 目标锁 → 结果行；首次不存在的结果也由目标锁串行。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeSql,
  scopeAllows,
  type ModuleScope,
} from '../permission/module-access.js';
import { requirePermission } from '../../authorization.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { codeOf, type SuccessionContext } from './access.js';
import { rowsOf } from './read-sql.js';
import { assertNoSyncBarrier } from './sync-barrier.js';
import type { ResultAdapter } from './write-support.js';
export interface HealthView {
  id: string;
  orgId: string;
  levelId: string | null;
  levelName: string | null;
  levelColor: string;
  method: string;
  computedAt: string | null;
  revision: number;
}
export const healthMissing = () => new AppError('NOT_FOUND', '健康度对象不存在');
export async function requireHealthOrg(tx: Tx, tenantId: string, orgId: string, asOf: string, scope: ModuleScope) {
  if (
    !scopeAllows(scope, { orgId }) ||
    !(await loadOrgSnapshot(tx, tenantId, asOf, undefined, { id: orgId, includeDisabled: false })).length
  )
    throw healthMissing();
}
export async function lockHealthTarget(tx: Tx, tenantId: string, orgId: string) {
  await tx.execute(sql`INSERT INTO succession_target_locks(tenant_id,target_kind,target_id)
    VALUES (${tenantId}::uuid,'org_health',${orgId}::uuid) ON CONFLICT DO NOTHING`);
  await tx.execute(sql`SELECT target_id FROM succession_target_locks WHERE tenant_id=${tenantId}::uuid
    AND target_kind='org_health' AND target_id=${orgId}::uuid FOR UPDATE`);
  await assertNoSyncBarrier(tx, tenantId, [{ kind: 'org_health', id: orgId }]);
  return rowsOf<{ levelId: string | null; method: string; revision: number }>(
    await tx.execute(sql`
    SELECT org_id AS "orgId",level_id AS "levelId",method,revision,run_id AS "runId",
      computed_at AS "computedAt",assigned_by AS "assignedBy",source_batch_id AS "sourceBatchId",
      source_project_id AS "sourceProjectId",source_meeting_id AS "sourceMeetingId"
    FROM succession_health_results WHERE tenant_id=${tenantId}::uuid AND org_id=${orgId}::uuid FOR UPDATE`),
  )[0];
}
export async function healthAccess(tx: Tx, deps: TenantRouteDeps, ctx: SuccessionContext) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  await requirePermission(bound.authorize, {
    ...ctx,
    action: 'object.view',
    resource: codeOf('healthResult'),
    fields: [],
  });
  return resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('healthResult'));
}
export async function readHealthResults(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  page: { limit: number; offset: number },
  ids?: readonly string[],
  asOf = tenantLocalDate(ctx.now, ctx.timezone),
) {
  const scope = await healthAccess(tx, deps, ctx);
  // 历史卡片用业务日选组织，结果仍是当前值；healthAccess 的权限范围始终按请求当日。
  const where = sql`v.tenant_id=${ctx.tenantId}::uuid AND v.enabled AND v.stop_date>=${asOf}::date
    AND ${scopeSql(scope, { org: sql`v.org_id` })}
    ${ids ? sql`AND v.org_id=ANY(${`{${ids.join(',')}}`}::uuid[])` : sql``}`;
  const latest = sql`(SELECT DISTINCT ON (org_id) * FROM org_versions
    WHERE tenant_id=${ctx.tenantId}::uuid AND start_date<=${asOf}::date
    ORDER BY org_id,start_date DESC,version_no DESC)`;
  const views = rowsOf<HealthView>(
    await tx.execute(sql`SELECT v.org_id AS id,v.org_id AS "orgId",
    r.level_id AS "levelId",l.name AS "levelName",
    COALESCE(l.color,s.default_color,'#F2F3F5') AS "levelColor",COALESCE(r.method,'computed') AS method,
    r.computed_at::text AS "computedAt",r.source_project_id AS "sourceProjectId",
    COALESCE(r.revision,0) AS revision
    FROM ${latest} v LEFT JOIN succession_health_results r ON r.tenant_id=v.tenant_id AND r.org_id=v.org_id
    LEFT JOIN succession_health_levels l ON l.tenant_id=r.tenant_id AND l.id=r.level_id
    LEFT JOIN succession_rule_settings s ON s.tenant_id=v.tenant_id AND s.kind='org_health'
    WHERE ${where} ORDER BY v.org_id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*)::int AS total FROM ${latest} v WHERE ${where}`),
  );
  if (ids && views.length !== ids.length) throw healthMissing();
  return { views, total: count!.total, revisions: new Map(views.map((v) => [v.id, v.revision])) };
}
export async function projectHealth(
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  views: readonly HealthView[],
  tx?: Tx,
) {
  const fields = tx
    ? await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('healthResult'), tx)
    : await getModuleViewableFields(deps, ctx, codeOf('healthResult'));
  return views.map((v) =>
    fields === undefined ? v : Object.fromEntries(Object.entries(v).filter(([k]) => fields.has(k))),
  );
}
export const healthResults: ResultAdapter<HealthView> = {
  object: 'healthResult',
  load: (tx, deps, ctx, ids) => readHealthResults(tx, deps, ctx, { limit: ids.length, offset: 0 }, ids),
  project: projectHealth,
};
export async function storeHealth(
  tx: Tx,
  ctx: SuccessionContext,
  orgId: string,
  levelId: string | null,
  method: 'manual' | 'computed',
  before: unknown,
  revision: number,
  runId: string | null = null,
) {
  await tx.execute(sql`INSERT INTO succession_health_results
    (tenant_id,org_id,level_id,method,revision,run_id,computed_at,assigned_by)
    VALUES (${ctx.tenantId}::uuid,${orgId}::uuid,${levelId}::uuid,${method},${revision},${runId}::uuid,
      ${ctx.now.toISOString()}::timestamptz,${method === 'manual' ? ctx.userId : null}::uuid)
    ON CONFLICT (tenant_id,org_id) DO UPDATE SET level_id=excluded.level_id,method=excluded.method,
      revision=excluded.revision,run_id=excluded.run_id,computed_at=excluded.computed_at,
      assigned_by=excluded.assigned_by,
      source_batch_id=NULL,source_project_id=NULL,source_meeting_id=NULL`);
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    objectType: codeOf('healthResult'),
    objectId: orgId,
    action: `succession.health-result.${method}`,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { orgId },
    before: before ?? null,
    after: {
      orgId,
      levelId,
      method,
      revision,
      runId,
      computedAt: ctx.now.toISOString(),
      assignedBy: method === 'manual' ? ctx.userId : null,
      sourceBatchId: null,
      sourceProjectId: null,
      sourceMeetingId: null,
    },
  });
}
export async function assignHealth(
  tx: Tx,
  ctx: SuccessionContext,
  scope: ModuleScope,
  orgId: string,
  expected: number,
  levelId: string | null,
) {
  await lockOrganizationSettings(tx, ctx.tenantId);
  // S 在目标锁之前；等级停用/删除与取值串行，不持目标锁反取规则锁。
  await tx.execute(sql`SELECT kind FROM succession_rule_settings WHERE tenant_id=${ctx.tenantId}::uuid
    AND kind='org_health' FOR SHARE`);
  const before = await lockHealthTarget(tx, ctx.tenantId, orgId);
  await requireHealthOrg(tx, ctx.tenantId, orgId, tenantLocalDate(ctx.now, ctx.timezone), scope);
  if ((before?.revision ?? 0) !== expected) throw new AppError('REVISION_CONFLICT', '健康度已修改，请刷新后重提');
  if (
    levelId &&
    !rowsOf(
      await tx.execute(sql`SELECT id FROM succession_health_levels WHERE tenant_id=${ctx.tenantId}::uuid
    AND id=${levelId}::uuid AND enabled FOR KEY SHARE`),
    ).length
  )
    throw healthMissing();
  // DEC-449：清除仅交还规则计算，保留同一行和递增的 CAS 版本。
  await storeHealth(tx, ctx, orgId, levelId, levelId === null ? 'computed' : 'manual', before, expected + 1);
}
