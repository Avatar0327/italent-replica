import { sql, type Tx } from '@italent/db';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

interface TimelinePoint {
  recordId: string;
  startDate: string;
}

export async function assertEmploymentDateAvailable(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  effectiveDate: string,
): Promise<void> {
  const [sameDay] = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM employment_records
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employeeId}::uuid
        AND start_date = ${effectiveDate}::date LIMIT 1
    `),
  );
  if (sameDay) {
    // TODO(需取证 Q-M0-20)：主职同日多条业务的先后顺序未定义，不以 UUID 或创建时间猜测。
    throw new EmploymentError('EMPLOYMENT_SAME_DATE_UNRESOLVED', '同一员工同日任职业务顺序尚未确定');
  }
}

async function neighbor(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  previous: boolean,
): Promise<TimelinePoint | undefined> {
  const comparison = previous ? sql`start_date < ${date}::date` : sql`start_date > ${date}::date`;
  const direction = previous ? sql`DESC` : sql`ASC`;
  const [point] = rowsOf<TimelinePoint>(
    await tx.execute(sql`
      SELECT record_id AS "recordId", start_date::text AS "startDate" FROM employment_timeline
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employeeId}::uuid AND ${comparison}
      ORDER BY start_date ${direction} LIMIT 1
    `),
  );
  return point;
}

/** 只改有效区间投影；业务快照、创建时的继承来源及后续记录都保持不变。 */
export async function insertEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  effectiveDate: string,
): Promise<{ previousRecordId: string | null; isInserted: boolean }> {
  const previous = await neighbor(tx, ctx, employeeId, effectiveDate, true);
  const next = await neighbor(tx, ctx, employeeId, effectiveDate, false);
  if (previous) {
    await tx.execute(sql`
      UPDATE employment_timeline SET valid_during = daterange(start_date, ${effectiveDate}::date, '[)')
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employeeId}::uuid
        AND record_id = ${previous.recordId}::uuid
    `);
  }
  await tx.execute(sql`
    INSERT INTO employment_timeline (tenant_id, employee_id, record_id, start_date, valid_during, created_at)
    VALUES (${ctx.tenantId}::uuid, ${employeeId}::uuid, ${recordId}::uuid, ${effectiveDate}::date,
      daterange(${effectiveDate}::date, ${next?.startDate ?? null}::date, '[)'), ${ctx.now.toISOString()}::timestamptz)
  `);
  // TODO(需取证 Q-M0-21)：首次入职尚未到期时没有当前记录；投影从真实首条日期开始，不造占位任职。
  // TODO(R1-T06)：补录只插入当前业务；向后更新需独立版本追加算法，不覆盖后续业务字段。
  return { previousRecordId: previous?.recordId ?? null, isInserted: !!next };
}

export async function employmentTimelineNeighbors(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string) {
  const previous = await neighbor(tx, ctx, employeeId, date, true);
  const next = await neighbor(tx, ctx, employeeId, date, false);
  return { previous, next };
}

export async function removeLatestEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  effectiveDate: string,
): Promise<void> {
  const { previous, next } = await employmentTimelineNeighbors(tx, ctx, employeeId, effectiveDate);
  if (next) {
    // TODO(需取证 Q-M0-22)：历史/跨周期删除及联动回滚由 R1-T11 处理。
    throw new EmploymentError('EMPLOYMENT_FUTURE_VERSION_EXISTS', '存在后续任职记录，不能删除历史记录');
  }
  await tx.execute(sql`
    DELETE FROM employment_timeline
    WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employeeId}::uuid AND record_id = ${recordId}::uuid
  `);
  if (previous) {
    await tx.execute(sql`
      UPDATE employment_timeline SET valid_during = daterange(start_date, NULL, '[)')
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employeeId}::uuid
        AND record_id = ${previous.recordId}::uuid
    `);
  }
}
