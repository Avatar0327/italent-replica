/**
 * F-055（R3-T02 实现拆分方案 §10）：任职记录事件的生效日门禁与处理时复核。
 *
 * 背景：未来生效的任职记录在保存当时就落到时间轴并同事务写出 `employment.record.create`（DEC-019），
 * 事件行只追加、不可改（迁移 0013）。“是否到期”因此不存在事件行上，而是读该事件对应记录的**当前**时间轴：
 * 记录是否仍有效、生效日是哪天，以 `employment_timeline` 为准（改期、删除都会改它）。
 *
 * 消费方约定（订阅 `employment.record.create` 的状态队列消费者：C1-4 资格同步、C2-1b 离职终止）：
 * 1. 一律“状态队列 + recordEventReadySql”取数，**不得用 created_at 高水位游标**，否则未到期事件会被游标越过；
 * 2. 取到后先 `lockEmploymentEmployee`（与任职写入、删除、改期同一把员工锁），再 `recheckRecordEvent`，
 *    再写派生数据（子集、终止评定）并更新队列行，三步同一事务；
 * 3. 三态处理：gone → skipped: RECORD_NOT_EFFECTIVE；not_yet → 回 pending（下次仍由 ReadySql 决定能否取到）；
 *    effective → 正常处理后 done。
 * `today` 一律传租户时区当天（DEC-056，见 recordEventToday）。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { loadEmploymentRecord } from './read-model.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

export const RECORD_CREATE_EVENT = 'employment.record.create';
export const RECORD_NOT_EFFECTIVE = 'RECORD_NOT_EFFECTIVE';

/** 租户时区的“今天”（DEC-056）；不用运行环境或浏览器的本地时区。 */
export function recordEventToday(ctx: Pick<EmploymentContext, 'now' | 'timezone'>): string {
  return tenantLocalDate(ctx.now, ctx.timezone);
}

/** 谓词内部的时间轴别名；取不易与外层别名（t、e 等）冲突的名字，外层同名会遮蔽内部引用（42703）。 */
const TIMELINE_ALIAS = 'rev_timeline';

function eventColumns(eventAlias: string): { type: SQL; tenant: SQL; object: SQL } {
  // 别名由调用方源码给出，不是用户输入；仍限定成标识符，杜绝拼接任意 SQL。
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(eventAlias) || eventAlias === TIMELINE_ALIAS)
    throw new TypeError(`事件表别名不合法：${eventAlias}`);
  return {
    type: sql.raw(`${eventAlias}.event_type`),
    tenant: sql.raw(`${eventAlias}.tenant_id`),
    object: sql.raw(`${eventAlias}.object_id`),
  };
}

/**
 * 严格到期：非 record.create 事件恒真；record.create 要求记录仍在时间轴上且 start_date ≤ today。
 * 已删除 / 已撤销的记录不在时间轴上，始终为假。transfer/completion.ts（DEC-163 补全待办）用它，行为保持不变。
 */
export function recordEventDueSql(eventAlias: string, today: string): SQL {
  const e = eventColumns(eventAlias);
  return sql`(${e.type} <> ${RECORD_CREATE_EVENT} OR EXISTS (
    SELECT 1 FROM employment_timeline rev_timeline
    WHERE rev_timeline.tenant_id = ${e.tenant} AND rev_timeline.record_id = ${e.object}
      AND rev_timeline.start_date <= ${today}::date))`;
}

/**
 * 队列取数：严格到期 **或记录已消失**。只有“仍在时间轴上且未到期”的事件不取；
 * “生效日前保存、消费前删除”的事件也会被取到，经 recheckRecordEvent 得到 gone 后标 skipped，不会永远停在 pending。
 */
export function recordEventReadySql(eventAlias: string, today: string): SQL {
  const e = eventColumns(eventAlias);
  return sql`(${recordEventDueSql(eventAlias, today)} OR NOT EXISTS (
    SELECT 1 FROM employment_timeline rev_timeline
    WHERE rev_timeline.tenant_id = ${e.tenant} AND rev_timeline.record_id = ${e.object}))`;
}

export type RecordEventRecheck =
  | { readonly kind: 'effective'; readonly record: EmploymentRecord }
  | { readonly kind: 'not_yet'; readonly effectiveDate: string }
  | { readonly kind: 'gone'; readonly reason: typeof RECORD_NOT_EFFECTIVE };

/**
 * 处理时复核：以**当前**时间轴为准，事件写出时的日期作废。
 * 调用方必须已持该员工的 `lockEmploymentEmployee` 锁；任职删除 / 改期同样先持这把锁，两者因此串行。
 * 读取复用 read-model 的时间轴读取；不带数据范围——只给后台消费者判断“该不该处理”，
 * 返回的 record 不得原样透出到任何响应、审计或通知（透出须另按查看人的范围与字段权裁剪）。
 */
export async function recheckRecordEvent(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  recordId: string,
  today: string,
): Promise<RecordEventRecheck> {
  if (!isUuid(recordId)) throw new AppError('VALIDATION_FAILED', '任职记录标识必须是 UUID');
  const record = await loadEmploymentRecord(tx, ctx.tenantId, recordId, today);
  if (!record) return { kind: 'gone', reason: RECORD_NOT_EFFECTIVE };
  if (record.effectiveDate > today) return { kind: 'not_yet', effectiveDate: record.effectiveDate };
  return { kind: 'effective', record };
}
