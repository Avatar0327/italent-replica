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
import type { Db, Tx } from '@italent/db';
import {
  runEmploymentOutboxConsumer,
  startEmploymentOutboxConsumer,
  type EmploymentOutboxConsumer,
  type OutboxConsumerProbe,
  type OutboxOutcome,
  type OutboxQueueRow,
  type OutboxRunOptions,
} from '../employment/outbox-consumer.js';
import type { EmploymentContext, EmploymentRecord } from '../employment/types.js';
import { lockPerson } from '../personnel/store.js';
import { loadSubset, persistSubset, saveSubset } from '../personnel/subsets.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { SYNCED_KINDS } from './sync-kinds.js';
import { mapEmploymentToQualification } from './sync-mapping.js';
import { hasSyncFootprint, planTimeline } from './sync-timeline.js';

export type { OutboxRunResult as SyncRunResult } from '../employment/outbox-consumer.js';
export const QUALIFICATION_SYNC_HANDLER = 'qualification_sync';
const SYNC_SETTING = 'qualification.sync_enabled';
const DAY_MS = 86_400_000;

export const qualificationSyncProbe: OutboxConsumerProbe & { beforeWrite?: (tx: Tx) => Promise<void> } = {};
const consumer: EmploymentOutboxConsumer = {
  kind: QUALIFICATION_SYNC_HANDLER,
  commandPrefix: 'qualification-sync',
  label: '资格同步',
  probe: qualificationSyncProbe,
  handle: handleQualificationSync,
};

export function runQualificationSync(db: Db, tenantId: string, options: OutboxRunOptions = {}) {
  return runEmploymentOutboxConsumer(db, tenantId, consumer, options);
}

export function qualificationSyncSchedulerEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.QUALIFICATION_SYNC_SCHEDULER !== 'off';
}

async function handleQualificationSync(
  tx: Tx,
  ctx: EmploymentContext,
  row: OutboxQueueRow,
  record: EmploymentRecord,
): Promise<OutboxOutcome> {
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
    queueId: row.id,
  });
  if (placement.kind === 'manual_same_day') return { state: 'skipped', reason: 'MANUAL_SAME_DAY' };
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

/** 进程启动入口：QUALIFICATION_SYNC_SCHEDULER=off 时不起消费者（返回 null）；间隔毫秒取 QUALIFICATION_SYNC_INTERVAL_MS，缺省 5000。 */
export function maybeStartQualificationSyncScheduler(db: Db, env: Readonly<Record<string, string | undefined>>) {
  if (!qualificationSyncSchedulerEnabled(env)) return null;
  return startQualificationSyncScheduler(db, Number(env.QUALIFICATION_SYNC_INTERVAL_MS || 5000));
}

export function startQualificationSyncScheduler(db: Db, intervalMs = 5000) {
  return startEmploymentOutboxConsumer(db, consumer, intervalMs);
}
