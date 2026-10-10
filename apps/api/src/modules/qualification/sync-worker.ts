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
import { classifyCommandFailure, recordCommandFailure, type CommandFailure } from '../../audit/failures.js';
import {
  recheckRecordEvent,
  recordEventReadySql,
  recordEventToday,
  RECORD_NOT_EFFECTIVE,
} from '../employment/record-events.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { saveSubset } from '../personnel/subsets.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { mapEmploymentToQualification } from './sync-mapping.js';

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
  afterRecheck?: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
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
  let failure: CommandFailure | undefined;
  try {
    const counted = await withTenant(db, ctx.tenantId, async (tx) => {
      // 锁序：员工 → 队列行（与任职写入、删除、改期同一把员工锁，F-055 §10.2）
      await lockEmploymentEmployee(tx, ctx, item.employeeId);
      const [row] = rowsOf<QueueRow>(
        await tx.execute(sql`SELECT id, employee_id AS "employeeId", record_id AS "recordId", attempts
          FROM ev_sync_queue WHERE tenant_id=${ctx.tenantId} AND id=${item.id}::uuid
            AND state IN ('pending','failed') AND next_attempt_at <= ${ctx.now.toISOString()}::timestamptz
          FOR UPDATE SKIP LOCKED`),
      );
      if (!row) return null; // 已被别的实例处理（或正被处理）
      try {
        const outcome = await tx.transaction((savepoint) => handle(savepoint, ctx, row, today));
        await settle(tx, ctx, row, outcome);
        return outcome.state === 'pending' ? null : outcome.state;
      } catch (error) {
        failure = classifyCommandFailure(error, 'execute');
        await markFailed(tx, ctx, row, failure.errorCode);
        return 'failed' as const;
      }
    });
    if (failure) await recordCommandFailure(db, ctx, ctx.commandId, failure);
    return counted;
  } catch (error) {
    // 队列行更新本身失败（存储不可写 / 连接断开）：事务已回滚，行保持原状，下一轮重试；不伪造结果。
    console.error('资格同步处理失败', ctx.commandId, error);
    return 'failed';
  }
}

async function handle(tx: Tx, ctx: EmploymentContext, row: QueueRow, today: string): Promise<Outcome> {
  const checked = await recheckRecordEvent(tx, ctx, row.recordId, today);
  await qualificationSyncProbe.afterRecheck?.();
  if (checked.kind === 'gone') return { state: 'skipped', reason: RECORD_NOT_EFFECTIVE };
  if (checked.kind === 'not_yet') return { state: 'pending', nextAttemptAt: dayBefore(checked.effectiveDate) };
  const { record } = checked;
  if (!SYNCED_KINDS.has(record.kind)) return { state: 'skipped', reason: 'KIND_NOT_SYNCED' };
  const setting = await readEffectiveSetting(tx, ctx.tenantId, SYNC_SETTING);
  if (setting.value !== true) return { state: 'skipped', reason: 'SETTING_DISABLED' };
  const mapped = await mapEmploymentToQualification(tx, ctx.tenantId, record.fields, record.effectiveDate);
  if (mapped.kind === 'skipped') return { state: 'skipped', reason: mapped.reason };
  if (await alreadySynced(tx, ctx.tenantId, record.id)) return { state: 'done', reason: null };
  await qualificationSyncProbe.beforeWrite?.();
  await saveSubset(
    tx,
    ctx,
    record.employeeId,
    'qualification',
    {
      categoryId: mapped.categoryId,
      levelId: mapped.levelId,
      startDate: record.effectiveDate,
      endDate: null,
      employmentRecordId: record.id,
      isAutoSync: true,
    },
    undefined,
    false,
    { type: 'employment_sync', id: record.id },
  );
  return { state: 'done', reason: null };
}

/** 该任职记录已同步过（含 HR 之后删除了的行）：重试 / 重复入队都不再写第二条。 */
async function alreadySynced(tx: Tx, tenantId: string, recordId: string): Promise<boolean> {
  const [found] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT 1 AS n FROM personnel_qualification
      WHERE tenant_id=${tenantId} AND employment_record_id=${recordId}::uuid
        AND source_type='employment_sync' LIMIT 1`),
  );
  return Boolean(found);
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

/** 失败：记次数与错误码（不存原始异常文案，防止带出个人信息），指数退避到下次重试（DEC-052）。 */
async function markFailed(tx: Tx, ctx: EmploymentContext, row: QueueRow, errorCode: string): Promise<void> {
  const attempts = row.attempts + 1;
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  await tx.execute(sql`UPDATE ev_sync_queue SET state='failed', reason=${errorCode}, attempts=${attempts},
    next_attempt_at=${new Date(ctx.now.getTime() + backoff).toISOString()}::timestamptz,
    updated_at=${ctx.now.toISOString()}::timestamptz WHERE tenant_id=${ctx.tenantId} AND id=${row.id}::uuid`);
}

/** 进程内调度：平台遍历租户，逐租户跑到本轮取空；多实例靠 SKIP LOCKED 与员工锁去重。 */
export function startQualificationSyncScheduler(db: Db, intervalMs = 5000) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = sweep(db)
      .catch((error: unknown) => console.error('资格同步调度失败', error))
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
