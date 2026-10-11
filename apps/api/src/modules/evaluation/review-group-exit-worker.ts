/**
 * F-092 / DEC-416⑦：未来直接离职的到期处理，沿用 C1-4 的状态队列、员工锁与 F-055 生效日复核。
 * 退组、revision、审计与队列终态同一事务；失败记受控错误码与次数并退避，提交回执丢失先回查，避免重复写。
 */
import { sql, withPlatform, withTenant, type Db, type Tx } from '@italent/db';
import { lockReviewGroupState, isDueReviewGroupLeave } from './review-group-state.js';
import { classifyCommandFailure, recordCommandFailure, type CommandPhase } from '../../audit/failures.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { recordEventReadySql, recordEventToday, recheckRecordEvent } from '../employment/record-events.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { exitEmployeeReviewGroups, REVIEW_GROUP_EXIT_HANDLER, settleReviewGroupExit } from './review-group-exit.js';

const BATCH = 100;
interface Picked {
  id: string;
  employeeId: string;
}
export interface ReviewGroupExitRun {
  picked: number;
  done: number;
  skipped: number;
  failed: number;
}
type Outcome = 'done' | 'skipped' | 'failed';

export async function runReviewGroupExits(
  db: Db,
  tenantId: string,
  options: { clock?: () => Date; limit?: number } = {},
): Promise<ReviewGroupExitRun> {
  const limit = options.limit ?? BATCH;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('退组批量上限须为 1～500');
  const [tenant] = await withPlatform(db, async (tx) =>
    rowsOf<{ timezone: string }>(
      await tx.execute(sql`
    SELECT timezone FROM tenants WHERE id=${tenantId}::uuid AND status='active'`),
    ),
  );
  const result = { picked: 0, done: 0, skipped: 0, failed: 0 };
  if (!tenant) return result;
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const ctx: EmploymentContext = {
    tenantId,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId: '',
    expectedRevision: 0,
  };
  const today = recordEventToday(ctx);
  const ready = await withTenant(db, tenantId, async (tx) =>
    rowsOf<Picked>(
      await tx.execute(sql`
    SELECT q.id, q.employee_id AS "employeeId" FROM ev_sync_queue q
    JOIN employment_outbox e ON e.tenant_id=q.tenant_id AND e.id=q.outbox_id
    WHERE q.tenant_id=${tenantId} AND q.handler=${REVIEW_GROUP_EXIT_HANDLER}
      AND q.state IN ('pending','failed') AND q.next_attempt_at<=${now.toISOString()}::timestamptz
      AND (${recordEventReadySql('e', today)}) ORDER BY q.employee_id, q.seq LIMIT ${limit}`),
    ),
  );
  result.picked = ready.length;
  for (const item of ready) {
    const outcome = await consume(db, { ...ctx, commandId: `review-group-exit:${item.id}` }, item, clock);
    if (outcome) result[outcome]++;
  }
  return result;
}

async function consume(db: Db, ctx: EmploymentContext, item: Picked, clock: () => Date): Promise<Outcome | null> {
  const progress: { phase: CommandPhase; attempts: number | null } = { phase: 'execute', attempts: null };
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      // 员工 → 队列 → 组（组 UUID 排序），与同事务离职及组编辑串行；多实例拿到终态后直接跳过。
      await lockEmploymentEmployee(tx, ctx, item.employeeId);
      const snapshot = await lockReviewGroupState(tx, ctx, [item.employeeId], clock);
      ctx = snapshot.ctx;
      const row = snapshot.queued.find((q) => q.id === item.id && new Date(q.nextAttemptAt) <= ctx.now);
      if (!row) return null;
      progress.attempts = Number(row.attempts);
      const checked = await recheckRecordEvent(tx, ctx, row.recordId, snapshot.today);
      if (checked.kind === 'not_yet') return null;
      let reason: string | null = null;
      if (checked.kind === 'gone') reason = checked.reason;
      else if (!isDueReviewGroupLeave(snapshot, checked.record)) {
        reason = 'KIND_NOT_LEAVE';
      }
      const state = reason ? 'skipped' : 'done';
      if (!reason) await exitEmployeeReviewGroups(tx, snapshot, [item.employeeId]);
      await settleReviewGroupExit(tx, ctx, row.id, state, reason);
      progress.phase = 'commit';
      return state;
    });
  } catch (error) {
    return recover(db, ctx, item.id, error, progress);
  }
}

async function recover(
  db: Db,
  ctx: EmploymentContext,
  id: string,
  error: unknown,
  progress: { phase: CommandPhase; attempts: number | null },
): Promise<Outcome> {
  let recheckFailed = false;
  if (progress.phase === 'commit') {
    try {
      const [landed] = await withTenant(db, ctx.tenantId, async (tx) =>
        rowsOf<{ state: string }>(
          await tx.execute(sql`
        SELECT state FROM ev_sync_queue WHERE tenant_id=${ctx.tenantId} AND handler=${REVIEW_GROUP_EXIT_HANDLER}
          AND id=${id}::uuid AND state IN ('done','skipped')`),
        ),
      );
      if (landed) return landed.state as 'done' | 'skipped';
    } catch {
      recheckFailed = true;
    }
  }
  const failure = classifyCommandFailure(error, progress.phase, recheckFailed);
  await recordCommandFailure(db, ctx, ctx.commandId, failure);
  await withTenant(db, ctx.tenantId, (tx) => markFailed(tx, ctx, id, progress.attempts, failure.errorCode)).catch(
    () => {
      // 存储仍不可写：原状态保留，下轮再试；不伪造终态，不把原始异常文案写进队列或日志。
    },
  );
  console.error('评审组自动退组失败', ctx.commandId, failure.outcome, failure.errorCode);
  return 'failed';
}

async function markFailed(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  attemptsBefore: number | null,
  errorCode: string,
) {
  const [row] = rowsOf<{ attempts: number }>(
    await tx.execute(sql`SELECT attempts FROM ev_sync_queue
    WHERE tenant_id=${ctx.tenantId} AND handler=${REVIEW_GROUP_EXIT_HANDLER} AND id=${id}::uuid
      AND state IN ('pending','failed') AND next_attempt_at<=${ctx.now.toISOString()}::timestamptz FOR UPDATE`),
  );
  // 未读队列行就失败时，次数以持久值为准；已读过则 CAS，不能覆盖其他实例的处理结果。
  if (!row || (attemptsBefore !== null && Number(row.attempts) !== attemptsBefore)) return;
  const attempts = Number(row.attempts) + 1;
  const backoff = Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
  // CAS 避免失去员工锁之后的失败恢复覆写另一实例已完成 / 已重试的行。
  await tx.execute(sql`UPDATE ev_sync_queue SET state='failed', reason=${errorCode}, attempts=${attempts},
    next_attempt_at=${new Date(ctx.now.getTime() + backoff).toISOString()}::timestamptz,
    updated_at=${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND handler=${REVIEW_GROUP_EXIT_HANDLER} AND id=${id}::uuid
      AND state IN ('pending','failed') AND attempts=${attempts - 1}`);
}

/** 进程调度按租户遍历；不叠加同进程的未完成轮次，多实例由员工锁和队列终态去重。 */
export function startReviewGroupExitScheduler(db: Db, intervalMs = 5000) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = sweep(db)
      .catch((error: unknown) =>
        console.error('评审组退组调度失败', classifyCommandFailure(error, 'execute').errorCode),
      )
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}

async function sweep(db: Db): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const tenants: { id: string }[] = await withPlatform(db, async (tx) =>
      rowsOf(
        await tx.execute(sql`
          SELECT id FROM tenants WHERE status='active' AND (${after}::uuid IS NULL OR id>${after}::uuid)
          ORDER BY id LIMIT 100`),
      ),
    );
    for (const tenant of tenants) {
      let result: ReviewGroupExitRun;
      do {
        result = await runReviewGroupExits(db, tenant.id);
      } while (result.picked >= BATCH && result.done + result.skipped + result.failed > 0);
    }
    if (tenants.length < 100) return;
    after = tenants.at(-1)!.id;
  }
}
