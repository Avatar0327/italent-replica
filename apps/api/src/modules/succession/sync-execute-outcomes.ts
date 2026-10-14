/** SP-12 / SP-14：提名写入结果、目标终态、R6 对象撤权与 R10 聚合统一生成回执。 */
import { and, eq, successionSyncItems as items, successionSyncTargets as targets, type Tx } from '@italent/db';
import { inArray } from 'drizzle-orm';
import type { OutcomeItem, SyncErrorCode, TalentReviewSyncPort } from '../talent-review/sync-port.js';
import type { ItemResult, SyncTarget, TargetContext } from './sync-execute-target.js';
import type { PlanFailure } from './sync-access.js';

export function outcome(ctx: TargetContext, rowKind: OutcomeItem['rowKind'], rowId: string, failure?: PlanFailure) {
  return {
    rowKind,
    rowId,
    executionNo: ctx.batch.executionNo!,
    pageCommandId: ctx.commandId,
    updatedAt: ctx.now,
    status: failure ? ('failed' as const) : ('synced' as const),
    recovery: failure?.code === 'STORAGE_UNAVAILABLE' ? ('retry_same_run' as const) : ('none' as const),
    ...(failure ? { errorCode: failure.code, errorParams: failure.params } : {}),
  };
}
export async function persistTarget(
  tx: Tx,
  ctx: TargetContext,
  target: SyncTarget,
  result: { results: ItemResult[]; ended: string[]; failure?: PlanFailure; manualKept?: boolean },
) {
  const rows: OutcomeItem[] = [];
  for (const r of result.results) {
    const row = outcome(ctx, 'nomination', r.item.nominationId, r.failure);
    rows.push(row);
    await tx
      .update(items)
      .set({
        execOutcome: r.outcome,
        recordId: r.recordId ?? null,
        errorCode: r.failure?.code ?? null,
        errorParams: r.failure?.params ?? null,
        retryable: row.recovery === 'retry_same_run',
        executionNo: ctx.batch.executionNo!,
        pageCommandId: ctx.commandId,
      })
      .where(and(eq(items.tenantId, ctx.batch.tenantId), eq(items.id, r.item.id)));
  }
  const health = target.targetKind === 'org_health';
  const row = {
    ...outcome(ctx, health ? 'org_health' : 'target', health ? target.targetId : target.targetRowKey, result.failure),
    ...(result.manualKept ? { errorParams: { manualKept: true } } : {}),
  };
  rows.push(row);
  await tx
    .update(targets)
    .set({
      status: result.failure ? 'failed' : 'done',
      retryable: row.recovery === 'retry_same_run',
      errorCode: result.failure?.code ?? null,
      errorParams: row.errorParams ?? null,
      endedRecordIds: result.ended,
      executionNo: ctx.batch.executionNo!,
      pageCommandId: ctx.commandId,
      doneAt: ctx.now,
    })
    .where(and(eq(targets.tenantId, ctx.batch.tenantId), eq(targets.id, target.id)));
  return rows;
}
export async function objectOutcomes(tx: Tx, ctx: TargetContext, port: TalentReviewSyncPort, objectIds: string[]) {
  if (!objectIds.length) return [];
  const existing = new Map<string, OutcomeItem>();
  let after: string | undefined;
  do {
    const page = await port.getOutcomes(tx, {
      tenantId: ctx.batch.tenantId,
      runId: ctx.batch.sourceRunId,
      consumer: 'succession',
      rowKind: 'object',
      limit: 2000,
      ...(after ? { after } : {}),
    });
    for (const row of page.items) existing.set(row.rowId, row);
    after = page.next ?? undefined;
  } while (after);
  const all = await tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.tenantId, ctx.batch.tenantId),
        eq(items.batchId, ctx.batch.id),
        inArray(items.objectId, [...new Set(objectIds)]),
      ),
    );
  const rows: OutcomeItem[] = [];
  for (const id of new Set(objectIds)) {
    const prior = existing.get(id);
    if (prior && prior.status !== 'pending' && !(prior.status === 'failed' && prior.recovery === 'retry_same_run'))
      continue;
    const base = outcome(ctx, 'object', id);
    if (ctx.denied.objectIds.includes(id)) {
      rows.push({ ...base, status: 'failed', errorCode: 'SOURCE_REVOKED', errorParams: { scope: 'object', ref: id } });
      continue;
    }
    const nominations = all.filter((n) => n.objectId === id);
    if (nominations.some((n) => n.planOutcome === 'planned' && n.execOutcome === null)) continue;
    const failed = nominations.filter((n) => n.planOutcome === 'failed' || n.execOutcome === 'failed');
    rows.push(
      failed.length
        ? {
            ...base,
            status: 'failed',
            errorCode: 'NOMINATIONS_FAILED',
            errorParams: {
              codes: [...new Set(failed.map((n) => n.errorCode as SyncErrorCode))],
              nominationIds: failed.map((n) => n.nominationId),
            },
            recovery: failed.some((n) => n.retryable) ? 'retry_same_run' : 'none',
          }
        : base,
    );
  }
  return rows;
}
