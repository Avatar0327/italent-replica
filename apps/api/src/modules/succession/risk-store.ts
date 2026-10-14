import { sql, type Tx } from '@italent/db';
import { tenantLocalDate, SUCCESSION_DEFAULT_COLORS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  scopeSql,
} from '../permission/module-access.js';
import { visibleJob } from '../permission/module-route-access.js';
import { loadJobObject } from '../job/read-model.js';
import { codeOf, type SuccessionContext } from './access.js';
import { rowsOf } from './read-sql.js';
import { lockTargets } from './record-write.js';
import { assertNoSyncBarrier } from './sync-barrier.js';
import type { ResultAdapter, WriteContext } from './write-support.js';
export interface RiskView {
  id: string;
  positionId: string;
  levelId: string | null;
  method: 'manual' | 'computed';
  revision: number;
  computedAt: string | null;
  levelName: string | null;
  levelColor: string;
}
/** 只查询当前范围内的行；列表和写结果复核分别完成对象授权后共用。 */
export async function readRiskRows(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  ids?: readonly string[],
  page = { limit: 200, offset: 0 },
  includeMissing = false,
) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, codeOf('riskResult'));
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  // 组织卡片的缺结果默认色仍走同一当前范围谓词，不补写结果行。
  const position = includeMissing ? sql`requested.id` : sql`r.position_id`;
  const source = includeMissing
    ? sql`FROM unnest(${`{${(ids ?? []).join(',')}}`}::uuid[]) requested(id)
        LEFT JOIN succession_risk_results r ON r.tenant_id=${ctx.tenantId}::uuid AND r.position_id=requested.id`
    : sql`FROM succession_risk_results r`;
  const where = sql`(r.tenant_id=${ctx.tenantId}::uuid OR (${includeMissing} AND r.tenant_id IS NULL))
    AND ${scopeSql(scope, { org: sql`p.org_id`, creator: sql`r.assigned_by` })}
    ${ids ? sql`AND ${position}=ANY(${`{${ids.join(',')}}`}::uuid[])` : sql``}`;
  const from = sql`${source} LEFT JOIN LATERAL (
    SELECT org_id,stop_date FROM job_position_versions WHERE tenant_id=${ctx.tenantId}::uuid AND object_id=${position}
    AND start_date<=${today}::date ORDER BY start_date DESC,version_no DESC LIMIT 1) p ON p.stop_date>=${today}::date
    LEFT JOIN succession_risk_levels l ON l.tenant_id=r.tenant_id AND l.id=r.level_id
    LEFT JOIN succession_rule_settings s ON s.tenant_id=${ctx.tenantId}::uuid AND s.kind='position_risk'`;
  const views = rowsOf<RiskView>(
    await tx.execute(sql`SELECT ${position} AS id,${position} AS "positionId",
    r.level_id AS "levelId",COALESCE(r.method,'computed') AS method,COALESCE(r.revision,0) AS revision,
    r.computed_at::text AS "computedAt",l.name AS "levelName",
    COALESCE(l.color,s.default_color,${SUCCESSION_DEFAULT_COLORS.position_risk}) AS "levelColor"
    ${from} WHERE ${where} ORDER BY ${position} LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const [count] = rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n ${from} WHERE ${where}`));
  return { views, total: count!.n, hasDataPermission: scope.hasDataPermission };
}
/** 写结果复核没有 HTTP 查看上下文，必须在每次首次返回 / 重放时重新授权。 */
export async function riskRead(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  ids?: readonly string[],
  page = { limit: 200, offset: 0 },
) {
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  await requirePermission(bound.authorize, {
    ...ctx,
    action: 'object.view',
    resource: codeOf('riskResult'),
    fields: [],
  });
  return readRiskRows(tx, bound, ctx, ids, page);
}
export async function projectRisk(deps: TenantRouteDeps, ctx: SuccessionContext, views: readonly RiskView[], tx?: Tx) {
  const fields = tx
    ? await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('riskResult'), tx)
    : await getModuleViewableFields(deps, ctx, codeOf('riskResult'));
  return views.map((v) =>
    fields === undefined ? v : Object.fromEntries(Object.entries(v).filter(([k]) => fields.has(k))),
  );
}
export const riskResults: ResultAdapter<RiskView> = {
  object: 'riskResult',
  async load(tx, deps, ctx, ids) {
    const { views } = await riskRead(tx, deps, ctx, ids);
    if (views.length !== ids.length) throw new AppError('NOT_FOUND', '风险结果不存在');
    return { views, revisions: new Map(views.map((v) => [v.id, v.revision])) };
  },
  project: projectRisk,
};
/** 结果列表与地图默认色共用字段投影；无结果卡片不伪造计算方式或 revision。 */
export async function projectRiskViews<T extends object>(
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  views: readonly T[],
  tx?: Tx,
) {
  const fields = tx
    ? await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('riskResult'), tx)
    : await getModuleViewableFields(deps, ctx, codeOf('riskResult'));
  return views.map((v) =>
    fields === undefined ? v : Object.fromEntries(Object.entries(v).filter(([k]) => fields.has(k))),
  );
}
/** 与 A2 / A3 / D1 共用目标锁；锁后才读结果行与计划屏障，包含尚无结果的首次写入。 */
export async function lockRisk(tx: Tx, tenantId: string, positionId: string) {
  await lockTargets(tx, tenantId, [{ kind: 'position', id: positionId }]);
  await assertNoSyncBarrier(tx, tenantId, [{ kind: 'position', id: positionId }]);
  return rowsOf<{ levelId: string | null; method: string; revision: number }>(
    await tx.execute(sql`
    SELECT level_id AS "levelId",method,revision FROM succession_risk_results
    WHERE tenant_id=${tenantId}::uuid AND position_id=${positionId}::uuid FOR UPDATE`),
  )[0];
}
export async function storeRisk(
  tx: Tx,
  input: {
    tenantId: string;
    positionId: string;
    orgId: string;
    levelId: string | null;
    method: 'manual' | 'computed';
    runId: string | null;
    userId: string;
    commandId: string;
    now: Date;
  },
  before: Awaited<ReturnType<typeof lockRisk>>,
) {
  const revision = (before?.revision ?? 0) + 1;
  await tx.execute(sql`INSERT INTO succession_risk_results
    (tenant_id,position_id,level_id,method,run_id,computed_at,assigned_by,revision)
    VALUES (${input.tenantId}::uuid,${input.positionId}::uuid,${input.levelId}::uuid,${input.method},
      ${input.runId}::uuid,${input.runId ? input.now.toISOString() : null}::timestamptz,
      ${input.runId ? null : input.userId}::uuid,${revision})
    ON CONFLICT (tenant_id,position_id) DO UPDATE SET level_id=excluded.level_id,method=excluded.method,
      run_id=excluded.run_id,computed_at=excluded.computed_at,
      assigned_by=excluded.assigned_by,revision=excluded.revision`);
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actorUserId: input.userId,
    objectType: codeOf('riskResult'),
    objectId: input.positionId,
    commandId: input.commandId,
    occurredAt: input.now,
    action: 'succession.risk-result.update',
    scope: { orgId: input.orgId },
    before: before ?? null,
    after: { positionId: input.positionId, levelId: input.levelId, method: input.method, revision },
  });
}
export async function assignRisk(tx: Tx, ctx: WriteContext, positionId: string, levelId: string | null) {
  const before = await lockRisk(tx, ctx.tenantId, positionId);
  await visibleJob(tx, ctx, ctx.scope, 'positions', positionId, ctx.today);
  const position = await loadJobObject(tx, ctx.tenantId, 'positions', positionId, ctx.today);
  if (!position?.isKey) throw new AppError('VALIDATION_FAILED', '职位不是有效关键职位');
  if ((before?.revision ?? 0) !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '风险结果已变更');
  if (
    levelId &&
    !rowsOf(
      await tx.execute(sql`SELECT id FROM succession_risk_levels
    WHERE tenant_id=${ctx.tenantId}::uuid AND id=${levelId}::uuid AND enabled FOR SHARE`),
    ).length
  )
    throw new AppError('NOT_FOUND', '风险等级不存在或已停用');
  await storeRisk(
    tx,
    {
      ...ctx,
      positionId,
      orgId: position.orgId!,
      levelId,
      method: levelId === null ? 'computed' : 'manual',
      runId: null,
    },
    before,
  );
  return { kind: 'record' as const, ids: [positionId] };
}
