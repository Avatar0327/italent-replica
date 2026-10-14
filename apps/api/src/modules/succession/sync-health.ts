/** §4.4：同步只写地图结果；不反写项目健康度，不把 empty 当作 DEC-449 的人工清除。 */
import { sql, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { PlanFailure, targetAt } from './sync-access.js';
import { rowsOf } from './read-sql.js';
import { enqueueCalcRun } from './calc-worker.js';
import type { SyncBatch, SyncTarget, TargetContext } from './sync-execute-target.js';

export async function executeHealthTarget(tx: Tx, ctx: TargetContext, target: SyncTarget) {
  const { tenantId } = ctx.batch,
    orgId = target.targetId;
  const wanted = { kind: 'org_health' as const, id: orgId };
  const state = await targetAt(tx, tenantId, wanted, ctx.batch.businessDate);
  if (!state?.current) throw new PlanFailure('TARGET_NOT_FOUND');
  if (!(await ctx.writer.covers(wanted))) throw new PlanFailure('TARGET_OUT_OF_SCOPE');
  const field = ctx.denied.orgFields[orgId]?.[0];
  if (target.healthStatus === 'forbidden' || ctx.denied.orgIds.includes(orgId) || field)
    throw new PlanFailure('SOURCE_REVOKED', { scope: field ? 'field' : 'org', ref: field ?? orgId });
  // 计划已排除 not_provided；异常计划不能悄悄清空原值。
  if (!['value', 'empty'].includes(target.healthStatus ?? '')) throw new PlanFailure('SOURCE_UNAVAILABLE');
  if (!ctx.healthMeetings?.has(orgId)) throw new PlanFailure('SOURCE_UNAVAILABLE');
  const meetingId = ctx.healthMeetings.get(orgId)!;
  const before = rowsOf<{ method: string; revision: number }>(
    await tx.execute(sql`
    SELECT org_id AS "orgId",level_id AS "levelId",method,revision,run_id AS "runId",
      computed_at AS "computedAt",assigned_by AS "assignedBy",source_batch_id AS "sourceBatchId",
      source_project_id AS "sourceProjectId",source_meeting_id AS "sourceMeetingId"
    FROM succession_health_results WHERE tenant_id=${tenantId}::uuid AND org_id=${orgId}::uuid FOR UPDATE`),
  )[0];
  if (before?.method === 'manual') return { results: [], ended: [], manualKept: true, failure: undefined };
  const method = target.healthManual ? 'manual' : 'synced';
  const after = {
    orgId,
    levelId: target.healthStatus === 'empty' ? null : target.healthLevelId,
    method,
    revision: (before?.revision ?? 0) + 1,
    runId: null,
    computedAt: ctx.now.toISOString(),
    assignedBy: target.healthManual ? ctx.writer.userId : null,
    sourceBatchId: ctx.batch.id,
    sourceProjectId: ctx.batch.projectId,
    sourceMeetingId: meetingId,
  };
  await tx.execute(sql`INSERT INTO succession_health_results
    (tenant_id,org_id,level_id,method,revision,run_id,computed_at,assigned_by,
      source_batch_id,source_project_id,source_meeting_id)
    VALUES (${tenantId}::uuid,${orgId}::uuid,${after.levelId}::uuid,${method},${after.revision},NULL,
      ${after.computedAt}::timestamptz,${after.assignedBy}::uuid,${ctx.batch.id}::uuid,${ctx.batch.projectId}::uuid,
      ${meetingId}::uuid)
    ON CONFLICT (tenant_id,org_id) DO UPDATE SET level_id=excluded.level_id,method=excluded.method,
      revision=excluded.revision,run_id=NULL,computed_at=excluded.computed_at,assigned_by=excluded.assigned_by,
      source_batch_id=excluded.source_batch_id,source_project_id=excluded.source_project_id,
      source_meeting_id=excluded.source_meeting_id`);
  await recordAudit(tx, {
    tenantId,
    actorUserId: ctx.writer.userId,
    objectType: 'Succession.HealthResult',
    objectId: orgId,
    action: 'succession.health-result.sync',
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { orgId },
    before: before ?? null,
    after,
  });
  return { results: [], ended: [], manualKept: false, failure: undefined };
}

/** 零执行目标和正常终结共用同一幂等键；按批次冻结，不重新扩展下一次计算集合。 */
export async function enqueueSyncHealth(tx: Tx, batch: SyncBatch, now: Date) {
  const orgs = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT DISTINCT target_id AS id
    FROM succession_sync_targets WHERE tenant_id=${batch.tenantId}::uuid AND batch_id=${batch.id}::uuid
    AND target_kind IN ('org','org_health') ORDER BY target_id`),
  );
  return enqueueCalcRun(
    tx,
    {
      tenantId: batch.tenantId,
      kind: 'org_health',
      trigger: 'review_sync',
      commandId: `${batch.id}:org_health`,
      batchId: batch.id,
      requestedBy: null,
      businessDate: batch.businessDate,
      objects: orgs.map((org) => ({ objectType: 'org', objectId: org.id })),
      scope: { sourceBatchId: batch.id },
    },
    now,
  );
}
