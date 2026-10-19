/**
 * 延长 / 结束申请的业务规则（docs/08_设计/R2-T05_兼职设计.md §4.4，PT-4c）：E-1～E-6 与 T-1～T-4 的唯一入口。
 * 申请的创建 / 修改 / 提交 / 审批编辑 / 落地各调一次，调用方已持有员工行锁与目标兼职记录头锁，传入锁内读到的当前行。
 * 各入口的口径差别只有一处 —— 是否复核“目标状态”（E-5 已结束、E-4 另有未办结申请）：
 * 创建 / 修改 / 提交 / 延长的审批编辑复核（state = true）；结束的审批编辑只重跑 T-1～T-2、落地复核重跑 E-1～E-3 / E-6 与 T-1～T-2，
 * 目标有没有被别人动过由落地的期号比对（changed_since_submit）管，不在这里（state = false）。
 * 顺序：先判输入本身（E-1 / E-2、T-1 / T-2，400 / 409），再判目标状态（E-5 → E-4），最后判需要读组织 / 时间轴的 E-3 与 E-6。
 */
import type { Tx } from '@italent/db';
import { PART_TIME_ERRORS, addDays, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { assertEmploymentDepartmentAvailableWithin } from '../references.js';
import type { EmploymentContext } from '../types.js';
import { assertPartTimeWithinCycle } from './boundary.js';
import type { PartTimeRecordRow } from './store.js';
import {
  dateRequestStateViolation,
  endDateViolation,
  openDateRequestRecords,
  type BatchEndViolation,
} from './validation.js';

export type DateRequestType = 'extend' | 'end';

export interface DateRequestCheck {
  /** 是否复核目标状态 E-5 / E-4（见文件头）。 */
  readonly state: boolean;
  /** 申请自己的草稿 / 审批中版本不算“另一张未办结申请”。 */
  readonly excludeRequestId?: string;
}

const reject = (violation: BatchEndViolation) =>
  new AppError(violation.code, violation.message, { reason: violation.reason, field: 'endDate' });

const conflict = (reason: string, message: string) => new AppError('CONFLICT', message, { reason });

/** E-1 / E-2：延长单只能把一个有限的结束日往后推（缩短走结束申请，A-5）。 */
function assertExtendsFurther(row: Pick<PartTimeRecordRow, 'endDate'>, endDate: string): string {
  if (row.endDate === null) throw conflict(PART_TIME_ERRORS.openEnded, '该兼职没有结束日期，无需延长');
  if (endDate <= row.endDate)
    throw conflict(PART_TIME_ERRORS.notExtended, `新结束日期必须晚于原结束日期（${row.endDate}），否则并未延长`);
  return row.endDate;
}

/**
 * 校验一张延长 / 结束申请的目标与新结束日；返回只提示不拦的信息（B-4，仅延长）。任一规则不通过抛业务错误，调用方整体回滚。
 * 延长另过组织 / 时间轴：E-3 延长段内兼职部门可用（持组织锁）、E-6 §4.3A 周期边界（含 B-2 已生效离职、B-3 审批中离职）。
 */
export async function checkDateRequest(
  tx: Tx,
  ctx: EmploymentContext,
  kind: DateRequestType,
  row: PartTimeRecordRow,
  endDate: string,
  check: DateRequestCheck,
): Promise<readonly string[]> {
  const original = kind === 'extend' ? assertExtendsFurther(row, endDate) : null;
  if (kind === 'end') {
    const violation = endDateViolation(row, endDate);
    if (violation) throw reject(violation);
  }
  if (check.state) {
    const open = (await openDateRequestRecords(tx, ctx, [row.id], check.excludeRequestId)).has(row.id);
    const violation = dateRequestStateViolation(row, tenantLocalDate(ctx.now, ctx.timezone), open);
    if (violation) throw reject(violation);
  }
  if (original === null) return [];
  await assertEmploymentDepartmentAvailableWithin(tx, ctx, row.departmentId, addDays(original, 1), addDays(endDate, 1));
  const { warnings } = await assertPartTimeWithinCycle(tx, ctx, {
    employeeId: row.employeeId,
    startDate: row.startDate,
    endDate,
    recordStaffId: row.staffId,
  });
  return warnings;
}
