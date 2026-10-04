import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

interface TimelinePoint {
  recordId: string;
  startDate: string;
  sortOrder: number;
}

/**
 * 操作先后键（DEC-108；PR #53 第二轮 P2-2）：申请取最近一次提交的状态事件序号（原站提交即写入版本链，W-417），
 * 直接业务取保存时的状态事件序号。正在落地的直接业务尚未写状态事件，键为空，视为最新一次操作。
 */
export function operationKey(tenantId: string, businessId: SQL): SQL {
  return sql`(SELECT COALESCE(max(e.event_seq) FILTER (WHERE e.state = 'in_review'), min(e.event_seq))
    FROM employment_state_events e WHERE e.tenant_id = ${tenantId} AND e.business_id = ${businessId})`;
}

/** 新记录在时间轴上的位置；shifted 表示当日已有操作更晚的记录，新记录插在它们之前（它们依次后移一位）。 */
export interface TimelinePosition {
  readonly date: string;
  readonly order: number;
  readonly shifted: boolean;
}

/**
 * 同一员工同一生效日按操作先后排序（DEC-108：当天最终状态取最后一次操作）：新记录排在当日第一条操作更晚的记录之前，
 * 没有则追加在当日最后。直接业务落地时总是最新操作，因此只有“先提交、后落地”的申请会插到当日中间。
 * 跨周期同日（DEC-077 保留部分）由入职类业务要求当日在前一条为离职 / 退休保证（write-service 的 assertBusinessSequence）。
 */
export async function timelinePosition(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  recordId?: string,
): Promise<TimelinePosition> {
  const mine = recordId ? operationKey(ctx.tenantId, sql`${recordId}::uuid`) : sql`NULL::bigint`;
  const [row] = rowsOf<{ before: number | null; append: number }>(
    await tx.execute(sql`
    SELECT
      (SELECT min(t.sort_order) FROM employment_timeline t
        WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND t.start_date=${date}::date
          AND ${operationKey(ctx.tenantId, sql`t.record_id`)} > ${mine})::int AS before,
      (SELECT COALESCE(max(sort_order) + 1, 0) FROM employment_timeline
        WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND start_date=${date}::date)::int AS append
  `),
  );
  const before = row?.before ?? null;
  return before === null
    ? { date, order: Number(row?.append ?? 0), shifted: false }
    : { date, order: Number(before), shifted: true };
}

async function neighbor(tx: Tx, ctx: EmploymentContext, employeeId: string, comparison: SQL, previous: boolean) {
  const direction = previous ? sql`DESC` : sql`ASC`;
  const [point] = rowsOf<TimelinePoint>(
    await tx.execute(sql`
    SELECT record_id AS "recordId", start_date::text AS "startDate", sort_order AS "sortOrder"
    FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND ${comparison}
    ORDER BY start_date ${direction}, sort_order ${direction} LIMIT 1
  `),
  );
  return point;
}

async function neighbors(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string, order: number) {
  return {
    previous: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) < (${date}::date, ${order})`, true),
    next: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) > (${date}::date, ${order})`, false),
  };
}

/** 新记录插入位置前后的记录：插到当日中间时，位置上现有的那条（随后后移）就是下一条。 */
async function neighborsAt(tx: Tx, ctx: EmploymentContext, employeeId: string, position: TimelinePosition) {
  const { date, order, shifted } = position;
  const after = shifted ? sql`>=` : sql`>`;
  return {
    previous: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) < (${date}::date, ${order})`, true),
    next: await neighbor(tx, ctx, employeeId, sql`(start_date, sort_order) ${after} (${date}::date, ${order})`, false),
  };
}

/**
 * 当日操作更晚的记录依次后移一位，给新记录腾出位置。投影只允许改区间（触发器），故删除后按原值重插、只改顺序号；
 * 不重叠与连续覆盖为延迟约束，事务提交时校验；当日顺序唯一约束因先删后插不会冲突。
 */
async function shiftSameDay(tx: Tx, ctx: EmploymentContext, employeeId: string, position: TimelinePosition) {
  await tx.execute(sql`
    WITH moved AS (
      DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid
        AND start_date=${position.date}::date AND sort_order >= ${position.order}
      RETURNING tenant_id, employee_id, record_id, staff_id, sort_order, start_date, valid_during, created_at
    )
    INSERT INTO employment_timeline
      (tenant_id, employee_id, record_id, staff_id, sort_order, start_date, valid_during, created_at)
    SELECT tenant_id, employee_id, record_id, staff_id, sort_order + 1, start_date, valid_during, created_at FROM moved
  `);
}

export async function insertEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  staffId: string,
  effectiveDate: string,
): Promise<{ previousRecordId: string | null; isInserted: boolean }> {
  const position = await timelinePosition(tx, ctx, employeeId, effectiveDate, recordId);
  const { previous, next } = await neighborsAt(tx, ctx, employeeId, position);
  // 同日在前的记录区间收缩为空：它仍在版本链上（变更前取它），但当天不再是当前任职。
  if (previous)
    await tx.execute(sql`
    UPDATE employment_timeline SET valid_during=daterange(start_date, ${effectiveDate}::date, '[)')
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${previous.recordId}::uuid
  `);
  if (position.shifted) await shiftSameDay(tx, ctx, employeeId, position);
  await tx.execute(sql`
    INSERT INTO employment_timeline
      (tenant_id,employee_id,record_id,staff_id,sort_order,start_date,valid_during,created_at)
    VALUES (${ctx.tenantId}::uuid,${employeeId}::uuid,${recordId}::uuid,${staffId}::uuid,${position.order},
      ${effectiveDate}::date,daterange(${effectiveDate}::date,${next?.startDate ?? null}::date,'[)'),
      ${ctx.now.toISOString()}::timestamptz)
  `);
  // TODO(需取证 Q-M0-21)：首次入职尚未到期时不造占位任职。
  return { previousRecordId: previous?.recordId ?? null, isInserted: !!next };
}

/** 新记录将插入的位置前后的记录（不给 recordId 时按当日最后）；调用方已持员工锁。 */
export async function employmentTimelineNeighbors(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  recordId?: string,
) {
  return neighborsAt(tx, ctx, employeeId, await timelinePosition(tx, ctx, employeeId, date, recordId));
}

export async function removeLatestEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
): Promise<void> {
  const [point] = rowsOf<TimelinePoint>(
    await tx.execute(sql`
    SELECT record_id AS "recordId", start_date::text AS "startDate", sort_order AS "sortOrder"
    FROM employment_timeline
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${recordId}::uuid
  `),
  );
  if (!point) throw new AppError('SERVICE_UNAVAILABLE', '任职记录缺少日期投影');
  const { previous, next } = await neighbors(tx, ctx, employeeId, point.startDate, point.sortOrder);
  if (next) {
    // TODO(R1-T11, DEC-012)：有联动变更时阻止删除；复杂历史回滚由 T11 处理。
    throw new EmploymentError('EMPLOYMENT_FUTURE_VERSION_EXISTS', '存在后续任职记录，不能删除历史记录');
  }
  await tx.execute(sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
    AND employee_id=${employeeId}::uuid AND record_id=${recordId}::uuid`);
  if (previous)
    await tx.execute(sql`UPDATE employment_timeline SET valid_during=daterange(start_date,NULL,'[)')
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${previous.recordId}::uuid`);
}
