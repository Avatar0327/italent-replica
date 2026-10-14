/** §4.6：有界恢复扫描；自动重试至多三次，接管失败不消耗次数。 */
import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  sql,
  withTenant,
  withPlatform,
  getTenant,
  successionSyncBatches as batches,
  type Db,
} from '@italent/db';
import { PlanFailure } from './sync-access.js';
import { SyncPortError } from '../talent-review/sync-port.js';
import { createPermissionAuthorizer } from '../permission/authorizer.js';
import { consumeRun, save, type SyncDeps } from './sync-consume.js';
import { batchWhere, claimSync, terminalBatch, retryTime, type SyncBatch } from './sync-control.js';
import { rowsOf } from './read-sql.js';
import { getSuccessionSync } from './ports.js';
export async function recoverSyncBatches(deps: SyncDeps, tenantId: string) {
  const tenant = await getTenant(deps.db, tenantId);
  if (!tenant || tenant.status !== 'active') return;
  let after = '';
  for (;;) {
    const page = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.tenantId, tenantId),
            sql`${batches.id}::text>${after}`,
            sql`${batches.status} IN ('executing','waiting','blocked')`,
          ),
        )
        .orderBy(batches.id)
        .limit(200),
    );
    if (!page.length) break;
    for (const batch of page) {
      try {
        await recoverBatch(deps, tenantId, tenant.timezone, batch);
      } catch (error) {
        // 单个来源不可用不阻塞后续批次；只更新本次观察到的版本，不能覆盖新 worker。
        await withTenant(deps.db, tenantId, async (tx) => {
          const [current] = await tx.select().from(batches).where(batchWhere(tenantId, batch.id)).for('update');
          if (
            current!.revision !== batch.revision ||
            terminalBatch(current!) ||
            current!.autoRetryCount >= 3 ||
            (current!.nextRetryAt && current!.nextRetryAt > deps.clock())
          )
            return;
          const count = current!.autoRetryCount + (current!.status === 'blocked' ? 1 : 0);
          await save(
            tx,
            current!,
            {
              status: 'blocked',
              autoRetryCount: count,
              nextRetryAt: retryTime(count, deps.clock()),
              blockReason:
                error instanceof SyncPortError || error instanceof PlanFailure ? error.code : 'STORAGE_UNAVAILABLE',
            },
            deps.clock(),
            `${batch.id}:recovery:${current!.revision}`,
            'blocked',
          );
        });
      }
    }
    after = page.at(-1)!.id;
  }
}
async function recoverBatch(deps: SyncDeps, tenantId: string, timezone: string, batch: SyncBatch) {
  const input = { tenantId, runId: batch.sourceRunId, leaseOwner: randomUUID() };
  const header = await withTenant(deps.db, tenantId, (tx) =>
    deps.port.loadRun(tx, { tenantId, runId: batch.sourceRunId }),
  );
  if (header?.status === 'superseded') {
    await claimSync(deps, input, batch, timezone);
    return;
  }
  if (
    batch.status !== 'executing' &&
    (batch.autoRetryCount >= 3 || (batch.nextRetryAt && batch.nextRetryAt > deps.clock()))
  )
    return;
  if (batch.hasPlan) {
    const claimed = await claimSync(deps, input, batch, timezone);
    if (!claimed || terminalBatch(claimed)) return;
  }
  if (batch.status === 'blocked') {
    const reserved = await withTenant(deps.db, tenantId, async (tx) => {
      const [current] = await tx.select().from(batches).where(batchWhere(tenantId, batch.id)).for('update');
      if (
        terminalBatch(current!) ||
        current!.autoRetryCount >= 3 ||
        (!batch.hasPlan && current!.revision !== batch.revision)
      )
        return false;
      await save(
        tx,
        current!,
        {
          autoRetryCount: current!.autoRetryCount + 1,
          nextRetryAt: retryTime(current!.autoRetryCount + 1, deps.clock()),
        },
        deps.clock(),
        `${batch.id}:retry:${current!.autoRetryCount + 1}`,
        'auto-retry',
      );
      return true;
    });
    if (!reserved) return;
  }
  await consumeRun(deps, input);
}
export async function runSyncRecovery(db: Db, now: Date) {
  const deps = getSuccessionSync({
    db,
    clock: () => now,
    authorize: createPermissionAuthorizer(db, undefined, () => now),
  });
  if (!deps) return;
  let after = '';
  for (;;) {
    const tenants = await withPlatform(db, (tx) =>
      tx.execute(sql`SELECT id FROM tenants
      WHERE status='active' AND id::text>${after} ORDER BY id LIMIT 100`),
    );
    const rows = rowsOf<{ id: string }>(tenants);
    if (!rows.length) return;
    for (const tenant of rows) await recoverSyncBatches(deps, tenant.id);
    after = rows.at(-1)!.id;
  }
}
