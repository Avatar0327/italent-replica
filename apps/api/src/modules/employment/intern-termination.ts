/**
 * 结束实习（R2 BE-6b；差距表 B41；补证结论 R2d / R2f1；31 IN-R7 / IN-R8；DEC-593）：结束实习 = 离职的一种。
 * 表单只有“实习结束日期”（必填）与“离职同步取消待入职”（布尔，默认否，标未证）；保存后免审批直接生效，
 * 经 createExitApplication 新建直接离职单（变动类型“实习结束”、类型 / 原因为空、不发交接），生效走离职生效链 activateExit，
 * 来源 free_direct（exitSourceOf：由变动类型判定，保存当场生效与到期调度生效同一来源），不另写一套生效逻辑。
 * 在途实习转正（DEC-593②④）：保存前先确认（沿用 CONFIRMATION_REQUIRED），确认后随生效链步骤 1 作废；
 * 经离职管理正常发起的离职仍按设计 §8B 拦截，不受本文件影响。
 */
import type { Tx } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { createExitApplication } from './exit-application.js';
import { assertLastWorkDateNotBeforeEntry, disclose, inFlightApplications, type InFlight } from './exit-gate.js';
import { lockExitParticipants } from './exit-lock-plan.js';
import { assertInternEndable } from './intern-eligibility.js';
import { lockEmploymentEmployee } from './record-store.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';

/**
 * 请求体：实习结束日期 = 离职的最后工作日（新任职从次日起，R2d）；cancelPendingEntry = 离职同步取消待入职（IN-R8，默认否）；
 * confirmed = 已确认“将作废在途转正”；pendingTransferAck = 在途调动确认令牌（沿用离职的 §8 机制，其余离职字段一律不受理）。
 */
export const internTerminationInput = z.strictObject({
  endDate: z.iso.date(),
  cancelPendingEntry: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  pendingTransferAck: z.string().max(200).optional(),
});
export type InternTerminationInput = z.infer<typeof internTerminationInput>;

const IN_REVIEW_NOTICE = '此人有转正申请在审批中，结束实习将作废该申请，确定？';
const PENDING_ENTRY_NOTICE = '此人有已通过审批、尚未生效的实习转正（待入职），结束实习将一并作废，确定？';
const RETURN_REASON = 'INTERN_REGULARIZATION_WILL_BE_VOIDED';

const toDisclosable = (rows: readonly InFlight[], extra: (row: InFlight) => object) =>
  rows.map((row) => ({ id: row.id, effectiveDate: row.planned, departmentId: row.departmentId, extra: extra(row) }));

/**
 * 在途实习转正的处理（保存前）：
 * - 审批通过、计划转正日 ≤ 结束日：转正会先于结束落地，人就不再是实习生，拒绝（确认也不放行）；
 * - 审批中：一律先确认（DEC-593④）；审批通过未生效的待入职：开关开启 = 生效时一并作废，不再确认；关闭 = 先确认（DEC-593②，未证的保守取法）。
 * 草稿 / 已驳回的申请不是“在途审批”，不提示，随生效链步骤 1 静默作废。
 */
async function confirmInFlightRegularizations(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: InternTerminationInput,
): Promise<void> {
  const rows = await inFlightApplications(
    tx,
    ctx,
    employeeId,
    ['intern_regularization'],
    ['in_review', 'approved'],
    'application',
    { unlanded: true },
  );
  const due = rows.filter((row) => row.state === 'approved' && row.planned <= input.endDate);
  if (due.length)
    throw new AppError('CONFLICT', '已通过审批的实习转正将在结束日当天或之前生效，请先处理该转正', {
      reason: 'INTERN_REGULARIZATION_DUE_BEFORE_END_DATE',
      ...(await disclose(tx, ctx, employeeId, toDisclosable(due, () => ({})))),
    });
  const warned = rows.filter((row) => row.state === 'in_review' || !input.cancelPendingEntry);
  if (!warned.length || input.confirmed) return;
  const shown = await disclose(
    tx,
    ctx,
    employeeId,
    toDisclosable(warned, (row) => ({ reason: RETURN_REASON, state: row.state })),
  );
  throw new AppError(
    'CONFLICT',
    warned.some((row) => row.state === 'in_review') ? IN_REVIEW_NOTICE : PENDING_ENTRY_NOTICE,
    { reason: 'CONFIRMATION_REQUIRED', warnings: shown.items, hiddenCount: shown.hiddenCount },
  );
}

export async function terminateIntern(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: InternTerminationInput,
): Promise<EmploymentBusiness> {
  // §5.2 ①：参与员工闭包先于任何其他锁（结束实习没有职责转交，闭包只有本人）；之后的判定都在员工锁内
  await lockExitParticipants(tx, ctx, [{ employeeId }]);
  await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  // 结束日期早于入职日期：原站保存校验未验证，按最保守做法拒绝，沿用离职门禁的日期校验码
  await assertLastWorkDateNotBeforeEntry(tx, ctx, employeeId, input.endDate);
  await assertInternEndable(tx, ctx, employeeId, input.endDate);
  await confirmInFlightRegularizations(tx, ctx, employeeId, input);
  return createExitApplication(tx, ctx, {
    employeeId,
    initiation: 'hr',
    mode: 'direct',
    lastWorkDate: input.endDate,
    exit: input.pendingTransferAck ? { pendingTransferAck: input.pendingTransferAck } : {},
    changeType: 'intern_end',
  });
}
