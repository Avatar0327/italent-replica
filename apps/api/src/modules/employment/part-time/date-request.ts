/**
 * 延长 / 结束申请的业务规则（docs/08_设计/R2-T05_兼职设计.md §4.4，PT-4c）：E-1～E-6 与 T-1～T-4 的唯一入口。
 * 申请的创建 / 修改 / 提交 / 审批编辑 / 落地各调一次，调用方已持有员工行锁与目标兼职记录头锁，传入锁内读到的当前行。
 * 各入口的口径差别只有一处 —— 是否复核“目标状态”（E-5 已结束、E-4 另有未办结申请）：
 * 创建 / 修改 / 提交 / 延长的审批编辑复核（state = true）；结束的审批编辑只重跑 T-1～T-2、落地复核重跑 E-1～E-3 / E-6 与 T-1～T-2，
 * 目标有没有被别人动过由落地的期号比对（changed_since_submit）管，不在这里（state = false）。
 * 顺序：先判输入本身（E-1 / E-2、T-1 / T-2，400 / 409），再判目标状态（E-5 → E-4），最后判需要读组织 / 时间轴的 E-3 与 E-6。
 * 延长填更早的结束日是可确认警告而非拦截（F-247，DEC-635）：缩短只在这里分支，调用方不各写一套。
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
  endBeforeStartViolation,
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

/**
 * E-1 / E-2 / T-1：延长单的新结束日。无结束日无需延长（409）；等于原结束日（409，原站未取证，保守拦截）；早于开始日（400）。
 * 早于原结束日不拦：原站弹“兼职并未延长”可确认警告，确认后按缩短保存（F-247，DEC-635），返回 shortened = true 交调用方提示。
 */
function checkExtendEnd(row: PartTimeRecordRow, endDate: string): { original: string; shortened: boolean } {
  if (row.endDate === null) throw conflict(PART_TIME_ERRORS.openEnded, '该兼职没有结束日期，无需延长');
  if (endDate === row.endDate)
    throw conflict(PART_TIME_ERRORS.notExtended, `新结束日期不能等于原结束日期（${row.endDate}），兼职并未延长`);
  const early = endBeforeStartViolation(row, endDate);
  if (early) throw reject(early);
  return { original: row.endDate, shortened: endDate < row.endDate };
}

/**
 * 校验一张延长 / 结束申请的目标与新结束日；返回只提示不拦的信息（延长缩短的 PART_TIME_NOT_EXTENDED、B-4）。任一规则不通过抛业务错误，
 * 调用方整体回滚。延长另过组织 / 时间轴：E-3 延长段内兼职部门可用（持组织锁，只在真正延长时）、E-6 §4.3A 周期边界
 * （含 B-2 已生效离职、B-3 审批中离职；缩短按 DEC-624 shortenOnly 跳过 B-3）。
 */
export async function checkDateRequest(
  tx: Tx,
  ctx: EmploymentContext,
  kind: DateRequestType,
  row: PartTimeRecordRow,
  endDate: string,
  check: DateRequestCheck,
): Promise<readonly string[]> {
  const extend = kind === 'extend' ? checkExtendEnd(row, endDate) : null;
  if (kind === 'end') {
    const violation = endDateViolation(row, endDate);
    if (violation) throw reject(violation);
  }
  if (check.state) {
    const open = (await openDateRequestRecords(tx, ctx, [row.id], check.excludeRequestId)).has(row.id);
    const violation = dateRequestStateViolation(row, tenantLocalDate(ctx.now, ctx.timezone), open);
    if (violation) throw reject(violation);
  }
  if (extend === null) return [];
  if (!extend.shortened)
    await assertEmploymentDepartmentAvailableWithin(
      tx,
      ctx,
      row.departmentId,
      addDays(extend.original, 1),
      addDays(endDate, 1),
    );
  const { warnings } = await assertPartTimeWithinCycle(tx, ctx, {
    employeeId: row.employeeId,
    startDate: row.startDate,
    endDate,
    recordStaffId: row.staffId,
    shortenOnly: extend.shortened,
  });
  return extend.shortened ? [PART_TIME_ERRORS.notExtended, ...warnings] : warnings;
}
