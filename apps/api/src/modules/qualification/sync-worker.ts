/**
 * 资格同步处理器与调度（R3-T02 C1-4，设计 §4.3 / §7.4；F-055 拆分方案 §10.2 消费方约定）。
 * 队列 ev_sync_queue 由迁移里的 employment_outbox 触发器入队；这里按“状态队列 + recordEventReadySql”取数，**没有时间游标**：
 * 每轮从 pending / failed 且到了 next_attempt_at 的行里，取记录已到期或已消失的，迟提交的事件下一轮自然被取到。
 * 每行单独事务：员工锁 → 取队列行（FOR UPDATE SKIP LOCKED，多实例各取各的）→ recheckRecordEvent 复核 → 写子集 → 更新队列行。
 * 处理结果：
 * - 记录已删除 / 撤销 → skipped: RECORD_NOT_EFFECTIVE；未到生效日 → 保持 pending（下一轮由 ReadySql 决定能否取到）；
 * - 业务类型不是入职 / 重聘 / 转正 / 调动类 → skipped: KIND_NOT_SYNCED（离职、退休、组织调整不同步，DEC-335② 🟡）；
 * - SW73 关 → skipped: SETTING_DISABLED；映射不唯一 / 没有命中 → skipped: AMBIGUOUS_MAPPING / NO_MAPPING（设计 §4.2）；
 * - 写子集：来源 employment_sync、isAutoSync = true、带任职记录 ID；该记录已有同步行则不再写（幂等）；
 * - 异常 → failed，attempts + 1、记错误码并指数退避（DEC-052），到点自动重试。
 * 写子集走通用的 saveSubset（子集策略、版本、审计同事务）。系统来源由 DEC-251 规定为可信系统值，用系统主体写入，不做人员范围校验。
 */
import { isUuid, sql, type Db, type Tx, withPlatform, withTenant } from '@italent/db';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import {
  classifyCommandFailure,
  recordCommandFailure,
  type CommandFailure,
  type CommandPhase,
} from '../../audit/failures.js';
import {
  recheckRecordEvent,
  recordEventReadySql,
  recordEventToday,
  RECORD_NOT_EFFECTIVE,
} from '../employment/record-events.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { lockPerson } from '../personnel/store.js';
import { loadSubset, persistSubset, saveSubset } from '../personnel/subsets.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { mapEmploymentToQualification } from './sync-mapping.js';
import { hasSyncFootprint, planTimeline } from './sync-timeline.js';

export const QUALIFICATION_SYNC_HANDLER = 'qualification_sync';
const SYNC_SETTING = 'qualification.sync_enabled';
/** 入职（含重聘、退休返聘）、转正（含实习转正）、调动同步；离职 / 退休 / 组织调整不同步（QL-R15②，DEC-335②）。 */
const SYNCED_KINDS: ReadonlySet<string> = new Set([
  'hire',
  'rehire',
  'retire_rehire',
  'regularization',
  'intern_regularization',
  'transfer',
]);
const BATCH = 100;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 测试探针：复核之后（仍持员工锁）/ 写子集之前各停一下，真 PG 交错与失败重试测试用。 */
export const qualificationSyncProbe: {
  afterRecheck?: (tx: Tx) => Promise<void>;
  beforeWrite?: (tx: Tx) => Promise<void>;
  afterSettle?: (tx: Tx) => Promise<void>;
} = {};

export interface SyncRunResult {
  readonly picked: number;
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}
interface Options {
  readonly clock?: () => Date;
  readonly limit?: number;
}
interface Picked {
  readonly id: string;
  readonly employeeId: string;
}
interface QueueRow extends Picked {
  readonly recordId: string;
  readonly outboxId: string;
  readonly attempts: number;
}
type Outcome =
  | { readonly state: 'done' | 'skipped'; readonly reason: string | null }
  | { readonly state: 'pending'; readonly nextAttemptAt: Date };

export function qualificationSyncSchedulerEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.QUALIFICATION_SYNC_SCHEDULER !== 'off';
}

/** 单租户的一轮：取一批到期的队列行逐行处理。 */
export async function runQualificationSync(db: Db, tenantId: string, options: Options = {}): Promise<SyncRunResult> {
  const limit = options.limit ?? BATCH;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError('同步批量上限须为 1～500');
  const clock = options.clock ?? (() => new Date());
  const result = { picked: 0, done: 0, skipped: 0, failed: 0 };
  const timezone = await tenantTimezone(db, tenantId);
  if (!timezone) return result;
  const base = { tenantId, timezone, userId: SYSTEM_USER_ID, expectedRevision: 0 };
  const now = clock();
  const today = recordEventToday({ now, timezone });
  const queue = await withTenant(db, tenantId, (tx) => pickReady(tx, tenantId, now, today, limit));
  result.picked = queue.length;
  for (const item of queue) {
    const ctx: EmploymentContext = { ...base, now: clock(), commandId: `qualification-sync:${item.id}` };
    const outcome = await consume(db, ctx, item, today);
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
async function pickReady(tx: Tx, tenantId: string, now: Date, today: string, limit: number): Promise<Picked[]> {
  return rowsOf<Picked>(
    await tx.execute(sql`SELECT q.id, q.employee_id AS "employeeId"
      FROM ev_sync_queue q
      JOIN employment_outbox e ON e.tenant_id=q.tenant_id AND e.id=q.outbox_id
      WHERE q.tenant_id=${tenantId} AND q.handler=${QUALIFICATION_SYNC_HANDLER}
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
): Promise<keyof SyncRunResult | null> {
  const progress: { phase: CommandPhase; attempts: number } = { phase: 'execute', attempts: 0 };
  let failure: CommandFailure | undefined;
  try {
    const counted = await withTenant(db, ctx.tenantId, async (tx) => {
      // 锁序：员工 → 队列行（与任职写入、删除、改期同一把员工锁，F-055 §10.2）
      await lockEmploymentEmployee(tx, ctx, item.employeeId);
      const [row] = rowsOf<QueueRow>(
        await tx.execute(sql`SELECT id, employee_id AS "employeeId", record_id AS "recordId", outbox_id AS "outboxId", attempts
          FROM ev_sync_queue WHERE tenant_id=${ctx.tenantId} AND id=${item.id}::uuid
            AND state IN ('pending','failed') AND next_attempt_at <= ${ctx.now.toISOString()}::timestamptz
          FOR UPDATE SKIP LOCKED`),
      );
      if (!row) return null; // 已被别的实例处理（或正被处理）
      progress.attempts = row.attempts;
      const result = await attempt(tx, ctx, row, today, (classified) => {
        failure = classified;
      });
      // 业务上的活都干完了，下面只剩提交：此后中断属于“结果未知”（探针 afterSettle 在这里模拟提交前后连接中断）
      progress.phase = 'commit';
      await qualificationSyncProbe.afterSettle?.(tx);
      return result;
    });
    if (failure) await recordCommandFailure(db, ctx, ctx.commandId, failure);
    return counted;
  } catch (error) {
    return recover(db, ctx, item, error, progress);
  }
}

/** 处理一行并更新队列行；确定的业务失败在本事务内落 failed，存储 / 连接故障时事务已不可用，原样抛给外层恢复。 */
async function attempt(
  tx: Tx,
  ctx: EmploymentContext,
  row: QueueRow,
  today: string,
  onBusinessFailure: (failure: CommandFailure) => void,
): Promise<keyof SyncRunResult | null> {
  try {
    const outcome = await tx.transaction((savepoint) => handle(savepoint, ctx, row, today));
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
 * failed（次数 + 1、错误码、退避）。重试是幂等的（同步足迹 hasSyncFootprint），所以“结果未知”也可以安全重试。
 * 审计库或队列都写不进去时保持原状、下一轮再试，不伪造结果；日志与队列只出现受控错误码，不带原始异常文案。
 */
async function recover(
  db: Db,
  ctx: EmploymentContext,
  item: Picked,
  error: unknown,
  progress: { phase: CommandPhase; attempts: number },
): Promise<keyof SyncRunResult> {
  let recheckFailed = false;
  if (progress.phase === 'commit') {
    try {
      const landed = await landedOutcome(db, ctx, item.id, progress.attempts);
      if (landed) return landed;
    } catch {
      recheckFailed = true;
    }
  }
  const failure = classifyCommandFailure(error, progress.phase, recheckFailed);
  await recordCommandFailure(db, ctx, ctx.commandId, failure);
  await withTenant(db, ctx.tenantId, (tx) => markFailed(tx, ctx, item.id, failure.errorCode)).catch(() => {
    /* 存储仍不可写：行保持原状，下一轮重试。 */
  });
  console.error('资格同步处理失败', ctx.commandId, failure.outcome, failure.errorCode);
  return 'failed';
}

/** 提交阶段中断后回查：队列行已是终态，或已记过本次失败，说明事务确实提交了。 */
async function landedOutcome(
  db: Db,
  ctx: EmploymentContext,
  id: string,
  attemptsBefore: number,
): Promise<keyof SyncRunResult | null> {
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

async function handle(tx: Tx, ctx: EmploymentContext, row: QueueRow, today: string): Promise<Outcome> {
  const checked = await recheckRecordEvent(tx, ctx, row.recordId, today);
  await qualificationSyncProbe.afterRecheck?.(tx);
  if (checked.kind === 'gone') return { state: 'skipped', reason: RECORD_NOT_EFFECTIVE };
  if (checked.kind === 'not_yet') return { state: 'pending', nextAttemptAt: dayBefore(checked.effectiveDate) };
  const { record } = checked;
  if (!SYNCED_KINDS.has(record.kind)) return { state: 'skipped', reason: 'KIND_NOT_SYNCED' };
  const setting = await readEffectiveSetting(tx, ctx.tenantId, SYNC_SETTING);
  if (setting.value !== true) return { state: 'skipped', reason: 'SETTING_DISABLED' };
  // 足迹先于映射：已同步过的任职记录（含 HR 之后编辑 / 删除了的）不再补回，口径 6 = A
  if (await hasSyncFootprint(tx, ctx.tenantId, record.id)) return { state: 'done', reason: null };
  const mapped = await mapEmploymentToQualification(tx, ctx.tenantId, record.fields, record.effectiveDate);
  if (mapped.kind === 'skipped') return { state: 'skipped', reason: mapped.reason };
  // 人员锁（员工行）之后再读时间轴：落位、收尾、取代在同一把锁内完成，与 HR 手工改子集串行
  await lockPerson(tx, ctx, record.employeeId);
  const placement = await planTimeline(tx, {
    tenantId: ctx.tenantId,
    employeeId: record.employeeId,
    startDate: record.effectiveDate,
    recordId: record.id,
    outboxId: row.outboxId,
  });
  if (placement.kind === 'superseded') return { state: 'skipped', reason: 'SUPERSEDED_SAME_DAY' };
  await qualificationSyncProbe.beforeWrite?.(tx);
  for (const old of placement.supersede) {
    const source = { type: 'employment_sync' as const, id: old.employmentRecordId! };
    await saveSubset(
      tx,
      { ...ctx, expectedRevision: old.revision },
      record.employeeId,
      'qualification',
      {},
      old.id,
      true,
      source,
    );
  }
  if (placement.closeId) await closePrevious(tx, ctx, record.employeeId, placement.closeId, record.effectiveDate);
  await saveSubset(
    tx,
    ctx,
    record.employeeId,
    'qualification',
    {
      categoryId: mapped.categoryId,
      levelId: mapped.levelId,
      startDate: record.effectiveDate,
      endDate: placement.endDate,
      employmentRecordId: record.id,
      isAutoSync: true,
    },
    undefined,
    false,
    { type: 'employment_sync', id: record.id },
  );
  return { state: 'done', reason: null };
}

/**
 * 收尾前一行：endDate 止于新开始日前一天。只改 endDate，来源 / 自动同步标记原样保留（手工行仍是手工行），
 * 经 persistSubset 留版本和审计；系统维护时间轴不走人工入口的策略复核（SW74 锁的是人工改删）。
 */
async function closePrevious(tx: Tx, ctx: EmploymentContext, employeeId: string, id: string, startDate: string) {
  const before = await loadSubset(tx, ctx, employeeId, 'qualification', id);
  const endDate = new Date(Date.parse(`${startDate}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  await persistSubset(tx, ctx, 'qualification', before, {
    ...before,
    endDate,
    revision: Number(before.revision) + 1,
    commandId: ctx.commandId,
  });
}

/** 未到生效日：下一次取数时间设为生效日前一天零点（UTC）——比任何时区的当地零点都早，真正的到期仍由 ReadySql 判定。 */
const dayBefore = (effectiveDate: string) => new Date(Date.parse(`${effectiveDate}T00:00:00Z`) - DAY_MS);

async function settle(tx: Tx, ctx: EmploymentContext, row: QueueRow, outcome: Outcome): Promise<void> {
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
export function startQualificationSyncScheduler(db: Db, intervalMs = 5000) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = sweep(db)
      .catch((error: unknown) => console.error('资格同步调度失败', classifyCommandFailure(error, 'execute').errorCode))
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
        await tx.execute(sql`SELECT id FROM tenants
          WHERE status='active' AND (${after}::uuid IS NULL OR id>${after}::uuid)
          ORDER BY id LIMIT 100`),
      ),
    );
    for (const tenant of tenants) {
      if (!isUuid(tenant.id)) continue;
      let result: SyncRunResult;
      do result = await runQualificationSync(db, tenant.id);
      while (result.picked >= BATCH && result.done + result.skipped + result.failed > 0);
    }
    if (tenants.length < 100) return;
    after = tenants.at(-1)!.id;
  }
}
