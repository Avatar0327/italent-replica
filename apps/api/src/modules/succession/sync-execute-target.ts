/** §5.7 E：整页锁已取得；每目标在保存点内重验并写业务，回执在保存点外落地。 */
import {
  and,
  eq,
  sql,
  successionRecords as records,
  type successionSyncBatches,
  type successionSyncItems,
  type successionSyncTargets,
  type Tx,
} from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import type { SourceReadAuthorization } from '../talent-review/sync-port.js';
import { PlanFailure, targetAt, type writerAccess } from './sync-access.js';
import { rowsOf, successorStatusSql } from './read-sql.js';

export type SyncBatch = typeof successionSyncBatches.$inferSelect;
export type SyncItem = typeof successionSyncItems.$inferSelect;
export type SyncTarget = typeof successionSyncTargets.$inferSelect;
type RecordRow = typeof records.$inferSelect;
export type ItemResult = {
  item: SyncItem;
  outcome: 'created' | 'updated' | 'exists' | 'failed';
  recordId?: string;
  failure?: PlanFailure;
};
export interface TargetContext {
  batch: SyncBatch;
  writer: Awaited<ReturnType<typeof writerAccess>>;
  denied: SourceReadAuthorization['forbidden'];
  now: Date;
  commandId: string;
  healthMeetings?: ReadonlyMap<string, string | null>;
}
export const openItem = (item: SyncItem) =>
  item.planOutcome === 'planned' && (item.execOutcome === null || (item.execOutcome === 'failed' && item.retryable));
export const openTarget = (target: SyncTarget) =>
  target.status === 'pending' || (target.status === 'failed' && target.retryable);

export function revoked(denied: SourceReadAuthorization['forbidden'], item: SyncItem) {
  if (denied.objectIds.includes(item.objectId)) return { scope: 'object', ref: item.objectId };
  if (denied.fields[item.objectId]?.length) return { scope: 'field', ref: denied.fields[item.objectId]![0] };
  const source = denied.sources.find((s) => s.objectId === item.objectId);
  return source ? { scope: 'source', ref: source.source } : undefined;
}
const TARGET_LEVEL_CODES = new Set(['TARGET_NOT_FOUND', 'TARGET_NOT_KEY_POSITION', 'TARGET_OUT_OF_SCOPE']);
/**
 * 整目标保存点回滚后的提名回执（设计 §5.7 回执映射，SP-14 R6）：目标级原因对全部 planned 提名同码，
 * 但源撤权涉及的提名仍写 SOURCE_REVOKED，与对象行对同一撤权给出一致原因。
 * 基础设施错误（可重试）不改写：撤权判定留待重试时的 validateItem。
 */
export function failedTarget(ctx: TargetContext, items: SyncItem[], failure: PlanFailure) {
  const results: ItemResult[] = items.map((item) => {
    const denied = TARGET_LEVEL_CODES.has(failure.code) ? revoked(ctx.denied, item) : undefined;
    return { item, outcome: 'failed', failure: denied ? new PlanFailure('SOURCE_REVOKED', denied) : failure };
  });
  return { failure, ended: [] as string[], results };
}
async function validateItem(tx: Tx, ctx: TargetContext, item: SyncItem) {
  const denied = revoked(ctx.denied, item);
  if (denied) return new PlanFailure('SOURCE_REVOKED', denied);
  const tenant = ctx.batch.tenantId;
  const id = sql`${item.successorEmployeeId}::uuid`;
  const [state] = rowsOf<{ active: boolean }>(
    await tx.execute(sql`SELECT
    (${successorStatusSql(tenant, id, ctx.batch.businessDate)} IS NOT NULL
    AND ${successorStatusSql(tenant, id, ctx.writer.today)} IS NOT NULL) AS active`),
  );
  if (!state?.active) return new PlanFailure('SUCCESSOR_NOT_ACTIVE');
  if (item.readinessId) {
    const [ready] = rowsOf<{ enabled: boolean }>(
      await tx.execute(sql`SELECT enabled FROM talent_readiness_levels
      WHERE tenant_id=${tenant}::uuid AND id=${item.readinessId}::uuid FOR SHARE`),
    );
    // 映射在计划阶段完成；执行时已删除与停用一样不可再选用（SP-14 R3）。
    if (!ready?.enabled) return new PlanFailure('READINESS_DISABLED');
  }
  return undefined;
}
async function auditRecord(tx: Tx, ctx: TargetContext, before: RecordRow | null, after: RecordRow) {
  const target = { kind: after.successionType, id: (after.targetOrgId ?? after.targetPositionId)! };
  const anchor = await targetAt(tx, ctx.batch.tenantId, target, ctx.writer.today);
  await recordAudit(tx, {
    tenantId: ctx.batch.tenantId,
    actorUserId: ctx.writer.userId,
    objectType: 'Succession.Record',
    objectId: after.id,
    action: `succession.record.${before ? 'update' : 'create'}`,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    before,
    after,
    scope: { orgId: after.targetOrgId ?? anchor?.org_id },
  });
}
async function closeOld(tx: Tx, ctx: TargetContext, target: SyncTarget, old: RecordRow[], successful: SyncItem[]) {
  if (target.action === 'append') return [];
  const keep = new Set(successful.map((n) => n.successorEmployeeId));
  const ended: string[] = [];
  for (const row of old) {
    if (!target.oldRecordIds.includes(row.id) || keep.has(row.successorEmployeeId)) continue;
    const [after] = await tx
      .update(records)
      .set({
        endDate: ctx.writer.today,
        endSource: target.action === 'overwrite' ? 'sync_overwrite' : 'sync_scope_overwrite',
        endedAt: ctx.now,
        endedBy: ctx.writer.userId,
        updatedBy: ctx.writer.userId,
        updatedAt: ctx.now,
        revision: row.revision + 1,
      })
      .where(and(eq(records.tenantId, ctx.batch.tenantId), eq(records.id, row.id)))
      .returning();
    await auditRecord(tx, ctx, row, after!);
    ended.push(row.id);
  }
  return ended;
}
async function writeItem(tx: Tx, ctx: TargetContext, target: SyncTarget, item: SyncItem, active: RecordRow[]) {
  const existing = active.find((r) => r.successorEmployeeId === item.successorEmployeeId);
  if (existing && target.action === 'append') return { item, outcome: 'exists' as const, recordId: existing.id };
  const provenance = {
    sourceKind: 'review_sync',
    sourceBatchId: ctx.batch.id,
    sourceItemId: item.id,
    updatedBy: ctx.writer.userId,
    updatedAt: ctx.now,
    readinessId: item.readinessId,
  };
  const [after] = existing
    ? await tx
        .update(records)
        .set({ ...provenance, revision: existing.revision + 1 })
        .where(and(eq(records.tenantId, ctx.batch.tenantId), eq(records.id, existing.id)))
        .returning()
    : await tx
        .insert(records)
        .values({
          ...provenance,
          tenantId: ctx.batch.tenantId,
          successionType: item.kind,
          targetOrgId: item.targetOrgId,
          targetPositionId: item.targetPositionId,
          successorEmployeeId: item.successorEmployeeId,
          startDate: ctx.writer.today,
          createdBy: ctx.writer.userId,
          createdAt: ctx.now,
        })
        .returning();
  await auditRecord(tx, ctx, existing ?? null, after!);
  if (existing) active.splice(active.indexOf(existing), 1, after!);
  else active.push(after!);
  return { item, outcome: existing ? ('updated' as const) : ('created' as const), recordId: after!.id };
}
export async function executeTarget(tx: Tx, ctx: TargetContext, target: SyncTarget, items: SyncItem[]) {
  const wanted = { kind: target.targetKind, id: target.targetId };
  const state = await targetAt(tx, ctx.batch.tenantId, wanted, ctx.batch.businessDate);
  if (!state || !state.current || !state.enabled) throw new PlanFailure('TARGET_NOT_FOUND');
  if (target.targetKind === 'position' && !state.is_key) throw new PlanFailure('TARGET_NOT_KEY_POSITION');
  if (!(await ctx.writer.covers(wanted))) throw new PlanFailure('TARGET_OUT_OF_SCOPE');
  const results: ItemResult[] = [];
  for (const item of items) {
    const failure = await validateItem(tx, ctx, item);
    results.push({ item, outcome: failure ? 'failed' : 'created', ...(failure ? { failure } : {}) });
  }
  const bad = results.filter((r) => r.failure);
  if (bad.length && target.action !== 'append') {
    const failure = new PlanFailure('TARGET_PARTIAL_NOMINATIONS', {
      causeNominationIds: bad.map((r) => r.item.nominationId),
    });
    return {
      results: results.map((r) => (r.failure ? r : { ...r, outcome: 'failed' as const, failure })),
      failure,
      ended: [],
    };
  }
  const active = await tx
    .select()
    .from(records)
    .where(
      and(
        eq(records.tenantId, ctx.batch.tenantId),
        eq(records.successionType, target.targetKind as 'org' | 'position'),
        sql`coalesce(${records.targetOrgId},${records.targetPositionId})=${target.targetId}::uuid`,
        sql`${records.deletedAt} IS NULL AND ${records.startDate}<=${ctx.writer.today}::date
      AND ${records.endDate}>${ctx.writer.today}::date`,
      ),
    )
    .orderBy(records.id)
    .for('update');
  const ended = await closeOld(
    tx,
    ctx,
    target,
    active,
    results.filter((r) => !r.failure).map((r) => r.item),
  );
  for (let i = 0; i < results.length; i++) {
    if (!results[i]!.failure) results[i] = await writeItem(tx, ctx, target, results[i]!.item, active);
  }
  return { results, ended, failure: undefined };
}
