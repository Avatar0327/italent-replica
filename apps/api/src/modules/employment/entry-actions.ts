/**
 * 待入职的状态动作（R2 BE-2a；docs/02_业务建模/34 EN-R8 / R9 / R14，DEC-484② / DEC-540 保守口径）：
 * 取消入职、改期入职、删除待入职。只做 F-129 已核实的状态变化，不联动 Offer / 信息采集 / 合同（未验证，见 PR 描述）。
 * 办理入职复用 employee-status.ts 的 completePendingEntry（其内含 DEC-138 / 139 校验）。
 */
import { sql, type Tx } from '@italent/db';
import { ENTRY_STATUS, ENTRY_REMARK_MAX, type EntryAction, type EntryCancelReason } from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { changePendingEntryStatus, lockPendingEntry } from './employee-status.js';
import { businessDate } from './fields.js';
import { lockEmploymentEmployee } from './record-store.js';
import { transitionEmployment } from './transitions.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';
import { createEmploymentBusiness, requireSavedBusiness } from './write-service.js';

interface EntryActionLog {
  readonly employeeId: string;
  readonly businessId: string;
  readonly previousBusinessId?: string;
  readonly action: EntryAction;
  readonly reason?: EntryCancelReason;
  readonly remark?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
}

function assertRemark(remark: string | undefined) {
  if (remark !== undefined && remark.length > ENTRY_REMARK_MAX)
    throw new AppError('VALIDATION_FAILED', `备注不能超过 ${ENTRY_REMARK_MAX} 字`);
}

async function logEntryAction(tx: Tx, ctx: EmploymentContext, log: EntryActionLog): Promise<void> {
  await tx.execute(sql`INSERT INTO employment_entry_actions(tenant_id, employee_id, business_id, previous_business_id,
      action, reason_code, remark, from_date, to_date, command_id, actor_user_id, created_at)
    VALUES (${ctx.tenantId}, ${log.employeeId}::uuid, ${log.businessId}::uuid, ${log.previousBusinessId ?? null}::uuid,
      ${log.action}, ${log.reason ?? null}, ${log.remark ?? null}, ${log.fromDate ?? null}::date,
      ${log.toDate ?? null}::date, ${ctx.commandId}, ${ctx.userId}::uuid, ${ctx.now.toISOString()}::timestamptz)`);
}

/** 取消入职（EN-R9）：入职状态 = 取消，进“已取消入职”；原因（5 项）与说明非必填；重复取消 409。 */
export async function cancelPendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: { readonly reason?: EntryCancelReason; readonly remark?: string },
): Promise<EmploymentBusiness> {
  assertRemark(input.remark);
  const record = await changePendingEntryStatus(tx, ctx, recordId, 'cancelled', { rejectUnchanged: true });
  await logEntryAction(tx, ctx, {
    employeeId: record.employeeId,
    businessId: recordId,
    action: 'cancel',
    reason: input.reason,
    remark: input.remark,
  });
  return requireSavedBusiness(tx, ctx, recordId);
}

/**
 * 改期入职（EN-R8）：入职日期必填、备注可选，入职状态变“延期”；已取消入职改期即恢复。
 * 任职记录的生效日 / 入职日不可原地改（只追加版本链，AGENTS §2），所以改期 = 删除原待入职记录并按新日期、原字段
 * 重建（同事务）；记录 ID 随之变化，两条用日志的 previous_business_id 串起。后面还有任职记录或在途申请时，
 * 删除一步按既有口径拒绝，整笔回滚。
 */
export async function postponePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: { readonly effectiveDate: string; readonly remark?: string },
): Promise<EmploymentBusiness> {
  assertRemark(input.remark);
  const effectiveDate = businessDate(input.effectiveDate);
  const { record } = await lockPendingEntry(tx, ctx, recordId);
  if (effectiveDate === record.effectiveDate && record.entryStatus !== ENTRY_STATUS.cancelled)
    throw new AppError('VALIDATION_FAILED', '改期后的入职日期不能与原入职日期相同', { reason: 'ENTRY_DATE_UNCHANGED' });
  await transitionEmployment(tx, ctx, { id: recordId, action: 'delete' });
  const employee = await lockEmploymentEmployee(tx, ctx, record.employeeId);
  const created = await createEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: employee.revision },
    record.employeeId,
    { kind: 'hire', mode: 'direct', effectiveDate, fields: record.fields, customFields: record.customFields },
    { entry: { pendingEntry: true, entryStatus: ENTRY_STATUS.postponed } },
  );
  await logEntryAction(tx, ctx, {
    employeeId: record.employeeId,
    businessId: created.id,
    previousBusinessId: recordId,
    action: 'postpone',
    remark: input.remark,
    fromDate: record.effectiveDate,
    toDate: effectiveDate,
  });
  await auditEmployment(
    tx,
    ctx,
    'employment.entry.postpone',
    'employment-business',
    created.id,
    { businessId: recordId, effectiveDate: record.effectiveDate, entryStatus: record.entryStatus },
    { businessId: created.id, effectiveDate, entryStatus: ENTRY_STATUS.postponed },
  );
  return created;
}

/**
 * 删除待入职（EN-R14，不可恢复）：只删待入职记录本身，已入职记录一律拒绝（NOT_PENDING_ENTRY）；人员主档保留（DEC-540）。
 * 同一内核也是“Offer 失效时删除待入职”的领域端口（F-171 / DEC-529，由 BE-14 在 Offer 侧调用）。
 */
export async function deletePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
): Promise<EmploymentBusiness> {
  await lockPendingEntry(tx, ctx, recordId);
  return transitionEmployment(tx, ctx, { id: recordId, action: 'delete' });
}
