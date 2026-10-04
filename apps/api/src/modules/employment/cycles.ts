import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import type { BusinessKind, EmploymentContext } from './types.js';

export interface CurrentEmploymentCycle {
  readonly id: string;
  readonly entryDate: string;
}

async function cycleAtTimelinePoint(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  predicate: SQL,
  direction: SQL,
): Promise<CurrentEmploymentCycle | null> {
  const [cycle] = rowsOf<CurrentEmploymentCycle>(
    await tx.execute(sql`
    SELECT r.staff_id AS id, r.entry_date::text AS "entryDate" FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.employee_id=t.employee_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND ${predicate}
    ORDER BY t.start_date ${direction}, t.sort_order ${direction} LIMIT 1
  `),
  );
  return cycle ?? null;
}

/**
 * “当前任职周期”（DEC-111；07 A2 向后更新只在当前周期内）：租户业务日当天所在的周期，即当天及以前最后一条
 * 任职所属的周期；首次入职尚未到来时取最早的周期。
 * TODO(需取证 Q-M0-26)：员工已有未来重聘周期时往今天所在周期补录未实测，暂按今天所在周期判断。
 */
export async function currentEmploymentCycle(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  asOf = tenantLocalDate(ctx.now, ctx.timezone),
): Promise<CurrentEmploymentCycle | null> {
  return (
    (await cycleAtTimelinePoint(tx, ctx, employeeId, sql`t.start_date <= ${asOf}::date`, sql`DESC`)) ??
    cycleAtTimelinePoint(tx, ctx, employeeId, sql`true`, sql`ASC`)
  );
}

// 原站只实测到调动表单的提示（W-412）；其他业务沿用同一句式，日期名称取通用的“生效日期”。
const DATE_LABELS: Partial<Record<BusinessKind, string>> = { transfer: '调动日期' };

/**
 * DEC-111（用户 2026-10-03 确认，照搬原站 W-412）：早于当前任职周期入职生效日的业务一律拒绝，
 * 不往已结束的旧任职周期补录，也不自动另开周期。
 */
export async function assertNotBeforeCurrentCycle(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: { readonly kind: BusinessKind; readonly effectiveDate: string },
): Promise<void> {
  const cycle = await currentEmploymentCycle(tx, ctx, employeeId);
  if (cycle && input.effectiveDate < cycle.entryDate) {
    const label = DATE_LABELS[input.kind] ?? '生效日期';
    throw new EmploymentError('EMPLOYMENT_BEFORE_CYCLE_ENTRY', `${label}不能早于入职生效日期（${cycle.entryDate}）`, {
      entryDate: cycle.entryDate,
    });
  }
}
