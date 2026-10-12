/**
 * 任职 outbox 状态队列的共用消费协议（DEC-447；R3-T02 设计 §4.3；F-055 §10.2）。
 * 从资格同步抽出：员工锁 → 队列行锁 → 有效记录复核 → 业务保存点 → 队列回执，同一事务。
 * 按 consumer.kind 独立取批次；未登记 kind 不取数。处理器只写业务，不自行提交或更新队列。
 */
import { isUuid, sql, type Db, type Tx, withPlatform, withTenant } from '@italent/db';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import {
  classifyCommandFailure,
  recordCommandFailure,
  type CommandFailure,
  type CommandPhase,
} from '../../audit/failures.js';
import { recheckRecordEvent, recordEventReadySql, recordEventToday, RECORD_NOT_EFFECTIVE } from './record-events.js';
import { lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

const BATCH = 100;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface OutboxRunResult {
  readonly picked: number;
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}
export interface OutboxRunOptions {
  readonly clock?: () => Date;
  readonly limit?: number;
}
interface Picked {
  readonly id: string;
  readonly employeeId: string;
}
export interface OutboxQueueRow extends Picked {
  readonly recordId: string;
  readonly attempts: number;
}
export type OutboxOutcome =
  | { readonly state: 'done' | 'skipped'; readonly reason: string | null }
  | { readonly state: 'pending'; readonly nextAttemptAt: Date };

/** 业务模块启动前按 kind 登记；kind 对应 ev_sync_queue.handler，不是任职业务类型。 */
export interface EmploymentOutboxConsumer {
  readonly kind: string;
  readonly commandPrefix: string;
  readonly label: string;
  readonly probe?: OutboxConsumerProbe;
  handle(tx: Tx, ctx: EmploymentContext, row: OutboxQueueRow, record: EmploymentRecord): Promise<OutboxOutcome>;
}

/** 仅供真实事务交错与提交回执丢失测试使用。 */
export interface OutboxConsumerProbe {
  afterRecheck?: (tx: Tx) => Promise<void>;
  afterSettle?: (tx: Tx) => Promise<void>;
  afterCommit?: () => Promise<void>;
}

/** 单租户的一轮：取一批到期的队列行逐行处理。 */
export async function runEmploymentOutboxConsumer(
  db: Db,
  tenantId: string,
  consumer: EmploymentOutboxConsumer,
  options: OutboxRunOptions = {},
): Promise<OutboxRunResult> {
  const limit = options.limit ?? BATCH;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('同步批量上限须为 1～500');
  const clock = options.clock ?? (() => new Date());
  const result = { picked: 0, done: 0, skipped: 0, failed: 0 };
  const timezone = await tenantTimezone(db, tenantId);
  if (!timezone) return result;
  const base = { tenantId, timezone, userId: SYSTEM_USER_ID, expectedRevision: 0 };
  const now = clock();
  const today = recordEventToday({ now, timezone });
  const queue = await withTenant(db, tenantId, (tx) => pickReady(tx, tenantId, now, today, limit, consumer.kind));
  result.picked = queue.length;
  for (const item of queue) {
    const ctx: EmploymentContext = { ...base, now: clock(), commandId: `${consumer.commandPrefix}:${item.id}` };
    const outcome = await consume(db, ctx, item, today, consumer);
    if (outcome) result[outcome]++;
  }
  return result;
}

async function tenantTimezone(db: Db, tenantId: string): Promise<string | null> {
  const [tenant] = await withPlatform(db, async (tx) =>
    rowsOf<{ timezone: string }>(
      await tx.execute(sql`SELECT timezone FROM tenants WHERE id=${tenantId}::uuid AND status='active'`),
    ),
  );
  return tenant?.timezone ?? null;
}

/** 取数：状态队列 + F-055 recordEventReadySql（已到期或记录已消失），不用 created_at 高水位。 */
async function pickReady(
  tx: Tx,
  tenantId: string,
  now: Date,
  today: string,
  limit: number,
  kind: string,
): Promise<Picked[]> {
  return rowsOf<Picked>(
    await tx.execute(sql`SELECT q.id, q.employee_id AS "employeeId"
      FROM ev_sync_queue q
      JOIN employment_outbox e ON e.tenant_id=q.tenant_id AND e.id=q.outbox_id
      WHERE q.tenant_id=${tenantId} AND q.handler=${kind}
        AND q.state IN ('pending','failed') AND q.next_attempt_at <= ${now.toISOString()}::timestamptz
        AND (${recordEventReadySql('e', today)})
      ORDER BY q.employee_id, q.created_at, q.id LIMIT ${limit}`),
  );
}

async function consume(
  db: Db,
  ctx: EmploymentContext,
  item: Picked,
  today: string,
  consumer: EmploymentOutboxConsumer,
): Promise<keyof OutboxRunResult | null> {
  const progress: { phase: CommandPhase; attempts: number } = { phase: 'execute', attempts: 0 };
  let failure: CommandFailure | undefined;
  try {
    const counted = await withTenant(db, ctx.tenantId, async (tx) => {
      // 锁序：员工 → 队列行（与任职写入、删除、改期同一把员工锁，F-055 §10.2）
      await lockEmploymentEmployee(tx, ctx, item.employeeId);
      const [row] = rowsOf<OutboxQueueRow>(
        await tx.execute(sql`SELECT id, employee_id AS "employeeId", record_id AS "recordId", attempts
          FROM ev_sync_queue WHERE tenant_id=${ctx.tenantId} AND id=${item.id}::uuid AND handler=${consumer.kind}
            AND state IN ('pending','failed') AND next_attempt_at <= ${ctx.now.toISOString()}::timestamptz
          FOR UPDATE SKIP LOCKED`),
      );
      if (!row) return null; // 已被别的实例处理（或正被处理）
      progress.attempts = row.attempts;
      const result = await attempt(tx, ctx, row, today, consumer, (classified) => {
        failure = classified;
      });
      // 业务上的活都干完了，下面只剩提交：此后中断属于“结果未知”（探针 afterSettle 在这里模拟提交前后连接中断）
      progress.phase = 'commit';
      await consumer.probe?.afterSettle?.(tx);
      return result;
    });
    await consumer.probe?.afterCommit?.();
    if (failure) await recordCommandFailure(db, ctx, ctx.commandId, failure);
    return counted;
  } catch (error) {
    return recover(db, ctx, item, error, progress, failure, consumer);
  }
}

/** 处理一行并更新队列行；确定的业务失败在本事务内落 failed，存储 / 连接故障时事务已不可用，原样抛给外层恢复。 */
async function attempt(
  tx: Tx,
  ctx: EmploymentContext,
  row: OutboxQueueRow,
  today: string,
  consumer: EmploymentOutboxConsumer,
  onBusinessFailure: (failure: CommandFailure) => void,
): Promise<keyof OutboxRunResult | null> {
  try {
    const outcome = await tx.transaction((savepoint) => handle(savepoint, ctx, row, today, consumer));
    await settle(tx, ctx, row, outcome);
    return outcome.state === 'pending' ? null : outcome.state;
  } catch (error) {
    const classified = classifyCommandFailure(error, 'execute');
    if (classified.outcome !== 'business_failed') throw error;
    onBusinessFailure(classified);
    await markFailed(tx, ctx, row.id, classified.errorCode);
    return 'failed';
  }
}

/**
 * 事务之外的失败恢复（照 job/sequence-worker.ts 的 recoverSequenceFailure）：提交阶段中断先回查持久状态，确认已落地的不重记、
 * 不重做；否则按阶段分类（提交前失败 = 存储不可写 / 业务失败，提交阶段中断 = 结果未知）写失败审计，再在独立事务里把队列行记为
 * failed（次数 + 1、错误码、退避）。重试是幂等的（终态回执与处理器自身业务判重），所以“结果未知”也可以安全重试。
 * 审计库或队列都写不进去时保持原状、下一轮再试，不伪造结果；日志与队列只出现受控错误码，不带原始异常文案。
 */
async function recover(
  db: Db,
  ctx: EmploymentContext,
  item: Picked,
  error: unknown,
  progress: { phase: CommandPhase; attempts: number },
  businessFailure: CommandFailure | undefined,
  consumer: EmploymentOutboxConsumer,
): Promise<keyof OutboxRunResult> {
  let recheckFailed = false;
  if (progress.phase === 'commit') {
    try {
      const landed = await landedOutcome(db, ctx, item.id, progress.attempts);
      if (landed) {
        // 失败已随事务落库、只是回执丢了：队列已经记好，原来的业务失败审计还没写，这里补记（不重复记次数）
        if (landed === 'failed' && businessFailure) await recordCommandFailure(db, ctx, ctx.commandId, businessFailure);
        return landed;
      }
    } catch {
      recheckFailed = true;
    }
  }
  const failure = classifyCommandFailure(error, progress.phase, recheckFailed);
  await recordCommandFailure(db, ctx, ctx.commandId, failure);
  await withTenant(db, ctx.tenantId, (tx) => markFailed(tx, ctx, item.id, failure.errorCode)).catch(() => {
    /* 存储仍不可写：行保持原状，下一轮重试。 */
  });
  console.error(`${consumer.label}处理失败`, ctx.commandId, failure.outcome, failure.errorCode);
  return 'failed';
}

/** 提交阶段中断后回查：队列行已是终态，或已记过本次失败，说明事务确实提交了。 */
async function landedOutcome(
  db: Db,
  ctx: EmploymentContext,
  id: string,
  attemptsBefore: number,
): Promise<keyof OutboxRunResult | null> {
  const [row] = await withTenant(db, ctx.tenantId, async (tx) =>
    rowsOf<{ state: string; attempts: number }>(
      await tx.execute(
        sql`SELECT state, attempts FROM ev_sync_queue WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`,
      ),
    ),
  );
  if (row?.state === 'done') return 'done';
  if (row?.state === 'skipped') return 'skipped';
  if (row?.state === 'failed' && Number(row.attempts) > attemptsBefore) return 'failed';
  return null;
}

async function handle(
  tx: Tx,
  ctx: EmploymentContext,
  row: OutboxQueueRow,
  today: string,
  consumer: EmploymentOutboxConsumer,
): Promise<OutboxOutcome> {
  const checked = await recheckRecordEvent(tx, ctx, row.recordId, today);
  await consumer.probe?.afterRecheck?.(tx);
  if (checked.kind === 'gone') return { state: 'skipped', reason: RECORD_NOT_EFFECTIVE };
  if (checked.kind === 'not_yet') return { state: 'pending', nextAttemptAt: dayBefore(checked.effectiveDate) };
  return consumer.handle(tx, ctx, row, checked.record);
}

/** 未到生效日：下一次取数时间设为生效日前一天零点（UTC）——比任何时区的当地零点都早，真正的到期仍由 ReadySql 判定。 */
const dayBefore = (effectiveDate: string) => new Date(Date.parse(`${effectiveDate}T00:00:00Z`) - DAY_MS);

async function settle(tx: Tx, ctx: EmploymentContext, row: OutboxQueueRow, outcome: OutboxOutcome): Promise<void> {
  const now = ctx.now.toISOString();
  if (outcome.state === 'pending') {
    await tx.execute(sql`UPDATE ev_sync_queue SET next_attempt_at=${outcome.nextAttemptAt.toISOString()}::timestamptz,
      updated_at=${now}::timestamptz WHERE tenant_id=${ctx.tenantId} AND id=${row.id}::uuid`);
    return;
  }
  await tx.execute(sql`UPDATE ev_sync_queue SET state=${outcome.state}, reason=${outcome.reason},
    attempts=${row.attempts + 1}, updated_at=${now}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND id=${row.id}::uuid`);
}

/** 失败：记次数与错误码（不存原始异常文案，防止带出个人信息），指数退避到下次重试（DEC-052）。行已是终态时不动。 */
async function markFailed(tx: Tx, ctx: EmploymentContext, id: string, errorCode: string): Promise<void> {
  const [row] = rowsOf<{ attempts: number }>(
    await tx.execute(sql`SELECT attempts FROM ev_sync_queue WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid
      AND state IN ('pending','failed') FOR UPDATE`),
  );
  if (!row) return;
  const attempts = Number(row.attempts) + 1;
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  await tx.execute(sql`UPDATE ev_sync_queue SET state='failed', reason=${errorCode}, attempts=${attempts},
    next_attempt_at=${new Date(ctx.now.getTime() + backoff).toISOString()}::timestamptz,
    updated_at=${ctx.now.toISOString()}::timestamptz WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`);
}

/** 进程内调度：平台遍历租户，逐租户跑到本轮取空；多实例靠 SKIP LOCKED 与员工锁去重。 */
export function startEmploymentOutboxConsumer(db: Db, consumer: EmploymentOutboxConsumer, intervalMs = 5000) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = sweep(db, consumer)
      .catch((error: unknown) =>
        console.error(`${consumer.label}调度失败`, classifyCommandFailure(error, 'execute').errorCode),
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

async function sweep(db: Db, consumer: EmploymentOutboxConsumer): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const tenants: { id: string }[] = await withPlatform(db, async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT id FROM tenants
          WHERE status='active' AND (${after}::uuid IS NULL OR id>${after}::uuid)
          ORDER BY id LIMIT 100`),
      ),
    );
    for (const tenant of tenants) {
      if (!isUuid(tenant.id)) continue;
      let result: OutboxRunResult;
      do result = await runEmploymentOutboxConsumer(db, tenant.id, consumer);
      while (result.picked >= BATCH && result.done + result.skipped + result.failed > 0);
    }
    if (tenants.length < 100) return;
    after = tenants.at(-1)!.id;
  }
}
