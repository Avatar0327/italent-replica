import { sql, type Tx } from '@italent/db';
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
 * 同一员工同一生效日的位置 = 当日已有记录之后（DEC-108：同周期同日按操作先后，后操作的成为当天当前任职）。
 * 跨周期同日（DEC-077 保留部分）也由此得到“结束周期类在前、开新周期类在后”：入职类业务要求当日已有的
 * 最后一条是离职 / 退休（write-service 的 assertBusinessSequence），因此新周期总是追加在旧周期结束之后。
 */
async function appendOrder(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string): Promise<number> {
  const [row] = rowsOf<{ next: number }>(
    await tx.execute(sql`
    SELECT COALESCE(max(sort_order) + 1, 0)::int AS next FROM employment_timeline
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND start_date=${date}::date
  `),
  );
  return row?.next ?? 0;
}

async function neighbor(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  order: number,
  previous: boolean,
) {
  const comparison = previous
    ? sql`(start_date, sort_order) < (${date}::date, ${order})`
    : sql`(start_date, sort_order) > (${date}::date, ${order})`;
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
    previous: await neighbor(tx, ctx, employeeId, date, order, true),
    next: await neighbor(tx, ctx, employeeId, date, order, false),
  };
}

export async function insertEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  staffId: string,
  effectiveDate: string,
): Promise<{ previousRecordId: string | null; isInserted: boolean }> {
  const sortOrder = await appendOrder(tx, ctx, employeeId, effectiveDate);
  const { previous, next } = await neighbors(tx, ctx, employeeId, effectiveDate, sortOrder);
  // 同日在前的记录区间收缩为空：它仍在版本链上（变更前取它），但当天不再是当前任职。
  if (previous)
    await tx.execute(sql`
    UPDATE employment_timeline SET valid_during=daterange(start_date, ${effectiveDate}::date, '[)')
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND record_id=${previous.recordId}::uuid
  `);
  await tx.execute(sql`
    INSERT INTO employment_timeline
      (tenant_id,employee_id,record_id,staff_id,sort_order,start_date,valid_during,created_at)
    VALUES (${ctx.tenantId}::uuid,${employeeId}::uuid,${recordId}::uuid,${staffId}::uuid,${sortOrder},
      ${effectiveDate}::date,daterange(${effectiveDate}::date,${next?.startDate ?? null}::date,'[)'),
      ${ctx.now.toISOString()}::timestamptz)
  `);
  // TODO(需取证 Q-M0-21)：首次入职尚未到期时不造占位任职。
  return { previousRecordId: previous?.recordId ?? null, isInserted: !!next };
}

/** 新记录将追加到的位置（生效日 + 当日最后）前后的记录；调用方已持员工锁。 */
export async function employmentTimelineNeighbors(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string) {
  return neighbors(tx, ctx, employeeId, date, await appendOrder(tx, ctx, employeeId, date));
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
