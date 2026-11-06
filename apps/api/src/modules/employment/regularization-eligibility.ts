/** DEC-788：转正申请入口与写入共用租户今天的在职试用主职口径。 */
import type { Tx } from '@italent/db';
import { EMPLOYEE_STATUS, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { loadProbationCycle, type ProbationCycle } from './probation.js';
import { findCurrentRecord, loadRegularizationResult } from './read-model.js';
import type { EmploymentContext } from './types.js';

/** 调用方先按既有入口校验员工范围；这里只判断业务资格，不代替授权。 */
export async function canApplyRegularization(tx: Tx, tenantId: string, employeeId: string, today: string) {
  const current = await findCurrentRecord(tx, tenantId, employeeId, today);
  return (
    current?.serviceType === 'primary' &&
    current.employeeStatus === EMPLOYEE_STATUS.probation &&
    current.fields.employType === 'internal'
  );
}

/** 写调用方持员工锁，避免资格检查和保存之间被离职 / 转正改变。 */
export async function requireRegularizationApplicant(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const eligible = await canApplyRegularization(tx, ctx.tenantId, employeeId, today);
  const cycle = eligible ? await loadProbationCycle(tx, ctx.tenantId, employeeId, today) : null;
  if (!cycle)
    throw new AppError('CONFLICT', '员工非在职试用状态，不能发起转正申请', {
      reason: 'ACTIVE_EMPLOYMENT_REQUIRED',
    });
  return cycle;
}

/** 暂存不校验必填；已填值与建单 / 修改 / 提交使用相同日期约束。 */
export function assertRegularizationDates(cycle: ProbationCycle, date?: string | null, result?: string | null) {
  if (!date) return;
  const { startDate, expectedEndDate } = cycle.info;
  const code = result?.trim().toLowerCase();
  if (date < cycle.anchor.entryDate) invalidDate('必须大于等于入职日期');
  if (startDate && date <= startDate) invalidDate('转正日期必须大于试用期开始日期');
  if (expectedEndDate && code === 'early' && date >= expectedEndDate)
    invalidDate('提前转正时，转正日期须早于预计试用结束日期');
  if (expectedEndDate && code === 'delayed' && date <= expectedEndDate)
    invalidDate('延期转正时，转正日期须晚于预计试用结束日期');
}

function invalidDate(message: string): never {
  throw new AppError('VALIDATION_FAILED', message, { fieldErrors: { effectiveDate: [message] } });
}

/** 草稿修改与提交按改后载荷校验；已保存结果即使字典停用仍可沿用（F-347）。 */
export async function assertRegularizationApplication(
  tx: Tx,
  ctx: EmploymentContext,
  business: { readonly id: string; readonly employeeId: string },
  payload: { readonly kind: string; readonly mode: string; readonly effectiveDate: string },
) {
  if (payload.kind !== 'regularization' || payload.mode !== 'application') return;
  const cycle = await requireRegularizationApplicant(tx, ctx, business.employeeId);
  const result = await loadRegularizationResult(tx, ctx.tenantId, business.id);
  assertRegularizationDates(cycle, payload.effectiveDate, result?.code);
}
