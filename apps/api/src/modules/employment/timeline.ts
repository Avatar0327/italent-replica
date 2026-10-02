import { sql, type Tx } from '@italent/db';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import type { BusinessKind, EmploymentContext } from './types.js';

interface TimelinePoint {
  recordId: string;
  startDate: string;
  sortOrder: number;
}
const END_KINDS: readonly BusinessKind[] = ['leave', 'retirement'];
const ENTRY_KINDS: readonly BusinessKind[] = ['hire', 'rehire', 'retire_rehire'];

/** DEC-077：同周期同日拒绝；跨周期仅允许结束业务后紧接入职类业务。 */
export async function assertEmploymentDateAvailable(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  effectiveDate: string,
  kind: BusinessKind,
  staffId?: string,
): Promise<void> {
  const sameDay = rowsOf<{ kind: BusinessKind; staffId: string }>(
    await tx.execute(sql`
    SELECT r.kind, r.staff_id AS "staffId" FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid
      AND t.start_date=${effectiveDate}::date
  `),
  );
  if (!sameDay.length) return;
  const allowedEntry =
    ENTRY_KINDS.includes(kind) &&
    sameDay.length === 1 &&
    END_KINDS.includes(sameDay[0]!.kind) &&
    (!staffId || sameDay[0]!.staffId !== staffId);
  if (!allowedEntry) {
    // TODO(需取证 Q-M0-20)：同一任职周期内同日多条业务的产品顺序仍待取证。
    throw new EmploymentError('EMPLOYMENT_SAME_DATE_UNRESOLVED', '同一任职周期同日只能有一条任职业务');
  }
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

export async function insertEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  staffId: string,
  effectiveDate: string,
  kind: BusinessKind,
): Promise<{ previousRecordId: string | null; isInserted: boolean }> {
  const sortOrder = END_KINDS.includes(kind) ? 0 : 1;
  const previous = await neighbor(tx, ctx, employeeId, effectiveDate, sortOrder, true);
  const next = await neighbor(tx, ctx, employeeId, effectiveDate, sortOrder, false);
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
  // TODO(R1-T06)：向后更新需独立版本追加算法，不覆盖后续业务字段。
  return { previousRecordId: previous?.recordId ?? null, isInserted: !!next };
}

export async function employmentTimelineNeighbors(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  date: string,
  kind: BusinessKind,
) {
  const order = END_KINDS.includes(kind) ? 0 : 1;
  return {
    previous: await neighbor(tx, ctx, employeeId, date, order, true),
    next: await neighbor(tx, ctx, employeeId, date, order, false),
  };
}

export async function removeLatestEmploymentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  effectiveDate: string,
  kind: BusinessKind,
): Promise<void> {
  const { previous, next } = await employmentTimelineNeighbors(tx, ctx, employeeId, effectiveDate, kind);
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
