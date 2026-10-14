/** DEC-019 / #293 P2-1：批次与通知共用审计入口；人工调用人显式传递，后台为 null。 */
import type { Tx, successionSyncBatches } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
type Batch = typeof successionSyncBatches.$inferSelect;
interface SyncAuditContext {
  actorUserId: string | null;
  now: Date;
  commandId: string;
  phase: string;
}
export function batchAuditSnapshot(batch: Batch) {
  const fields = [
    'status',
    'hasPlan',
    'strategy',
    'writePrincipalUserId',
    'actorScopeCheckedAt',
    'result',
    'blockReason',
    'endReason',
    'executionNo',
    'leaseOwner',
    'nextPageNo',
    'autoRetryCount',
    'nextRetryAt',
    'plannedAt',
    'startedAt',
    'finishedAt',
    'revision',
  ] as const;
  return Object.fromEntries(fields.map((field) => [field, batch[field]]));
}
export async function recordSyncAudit(
  tx: Tx,
  batch: Pick<Batch, 'tenantId' | 'id'>,
  ctx: SyncAuditContext,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: batch.tenantId,
    actorUserId: ctx.actorUserId,
    objectType: 'Succession.SyncBatch',
    objectId: batch.id,
    action: `succession.sync-batch.${ctx.phase}`,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    before,
    after,
  });
}
