/** D3 / SP-08、13、DEC-453①：接管与终止遵循互斥 → 消费记录 → 批次/计划行。 */
import { and, eq, sql, withTenant, successionSyncBatches as batches, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { SyncPortError } from '../talent-review/sync-port.js';
import { mutex, release, save, type SyncDeps, type SyncInput } from './sync-consume.js';
import { authorizeRequesterTargets } from './sync-access.js';
import { rowsOf } from './read-sql.js';
export type SyncBatch = typeof batches.$inferSelect;
export const terminalBatch = (b: SyncBatch) => ['completed', 'terminated', 'rejected'].includes(b.status);
export const batchWhere = (tenant: string, id: string) => and(eq(batches.tenantId, tenant), eq(batches.id, id));
export const notRetryable = () => new AppError('FORBIDDEN', '同步批次不可重试', { reason: 'RUN_NOT_RETRYABLE' });
export const retryTime = (count: number, now: Date) =>
  count < 3 ? new Date(now.getTime() + [1, 5, 30][count]! * 60_000) : null;
export async function requesterScope(tx: Tx, deps: SyncDeps, input: SyncInput, timezone: string, batch: SyncBatch) {
  if (!input.requesterUserId) return;
  const targets = rowsOf<{ kind: 'org' | 'position' | 'org_health'; id: string }>(
    await tx.execute(sql`
    SELECT target_kind AS kind,target_id AS id FROM succession_sync_targets
    WHERE tenant_id=${input.tenantId}::uuid AND batch_id=${batch.id}::uuid
    AND (status='pending' OR (status='failed' AND retryable))`),
  );
  await authorizeRequesterTargets(
    deps,
    tx,
    { tenantId: input.tenantId, timezone, userId: input.requesterUserId },
    targets,
  );
}
export async function terminateLocal(
  tx: Tx,
  batch: SyncBatch,
  reason: 'aborted' | 'superseded',
  now: Date,
  command: string,
  actorUserId: string | null = null,
  executionNo = batch.executionNo,
) {
  await tx.execute(sql`UPDATE succession_sync_targets SET status='aborted',retryable=false
    WHERE tenant_id=${batch.tenantId}::uuid AND batch_id=${batch.id}::uuid
    AND (status='pending' OR (status='failed' AND retryable))`);
  await tx.execute(sql`UPDATE succession_sync_items SET exec_outcome='aborted',retryable=false
    WHERE tenant_id=${batch.tenantId}::uuid AND batch_id=${batch.id}::uuid AND plan_outcome='planned'
    AND (exec_outcome IS NULL OR (exec_outcome='failed' AND retryable))`);
  await release(tx, batch);
  return save(
    tx,
    batch,
    {
      status: 'terminated',
      endReason: reason,
      blockReason: null,
      finishedAt: now,
      nextRetryAt: null,
      executionNo,
    },
    now,
    command,
    'terminated',
    actorUserId,
  );
}
export async function abortSync(
  tx: Tx,
  deps: SyncDeps,
  batch: SyncBatch,
  commandId: string,
  expectedRevision: number,
  actorUserId: string | null = null,
) {
  const key = { tenantId: batch.tenantId, runId: batch.sourceRunId, consumer: 'succession' as const };
  // 调用方先取互斥；不先锁批次，避免与持消费记录 S 锁的执行页形成反向等待。
  let executionNo = batch.executionNo;
  if (executionNo === null) {
    const state = await deps.port.beginConsumption(tx, { ...key, leaseOwner: commandId, leaseSeconds: 120 });
    if (state.status === 'superseded')
      return terminateLocal(tx, batch, 'superseded', deps.clock(), commandId, actorUserId);
    executionNo = state.executionNo;
  }
  const state = await deps.port.abortConsumption(tx, {
    ...key,
    executionNo,
    code: 'ABORTED_BY_ADMIN',
    recovery: 'terminate',
  });
  const [current] = await tx.select().from(batches).where(batchWhere(batch.tenantId, batch.id)).for('update');
  if (current!.revision !== expectedRevision)
    throw new AppError('REVISION_CONFLICT', '同步批次已变化', { reason: 'REVISION_MISMATCH' });
  if (terminalBatch(current!)) return current!;
  return terminateLocal(
    tx,
    current!,
    state.status === 'superseded' ? 'superseded' : 'aborted',
    deps.clock(),
    commandId,
    actorUserId,
    executionNo,
  );
}
export async function claimSync(deps: SyncDeps, input: SyncInput, batch: SyncBatch, timezone: string) {
  const transaction =
    deps.transaction ?? (<T>(work: (tx: Tx) => Promise<T>) => withTenant(deps.db, input.tenantId, work));
  try {
    return await transaction(async (tx) => {
      await mutex(tx, input.tenantId);
      const [current] = await tx.select().from(batches).where(batchWhere(input.tenantId, batch.id));
      if (terminalBatch(current!)) return current!;
      await requesterScope(tx, deps, input, timezone, current!);
      const key = { tenantId: input.tenantId, runId: input.runId, consumer: 'succession' as const };
      const header = await deps.port.loadRun(tx, key);
      if (header?.status === 'superseded')
        return terminateLocal(
          tx,
          current!,
          'superseded',
          deps.clock(),
          `${input.runId}:superseded`,
          input.requesterUserId ?? null,
        );
      if (current!.leaseOwner === input.leaseOwner) return current!;
      const state = await deps.port.beginConsumption(tx, { ...key, leaseOwner: input.leaseOwner, leaseSeconds: 120 });
      if (state.status !== 'running')
        return terminateLocal(
          tx,
          current!,
          state.status === 'superseded' ? 'superseded' : 'aborted',
          deps.clock(),
          `${input.runId}:terminated`,
          input.requesterUserId ?? null,
        );
      const [locked] = await tx.select().from(batches).where(batchWhere(input.tenantId, batch.id)).for('update');
      return save(
        tx,
        locked!,
        {
          executionNo: state.executionNo,
          leaseOwner: input.leaseOwner,
          status: 'executing',
          blockReason: null,
          nextRetryAt: null,
        },
        deps.clock(),
        `${input.runId}:claim:${state.executionNo}`,
        'claim',
        input.requesterUserId ?? null,
      );
    });
  } catch (error) {
    if (error instanceof SyncPortError && error.code === 'CONSUMPTION_LEASED') return undefined;
    throw error;
  }
}
