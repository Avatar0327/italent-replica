/**
 * 待入职的状态动作（R2 BE-2a；docs/02_业务建模/34 EN-R8 / R9 / R14，DEC-484② / DEC-540 保守口径）：
 * 取消入职、改期入职、编辑待入职（F-188）、删除待入职。只做 F-129 已核实的状态变化，不联动 Offer / 信息采集 / 合同（未验证，见 PR 描述）。
 * 办理入职复用 employee-status.ts 的 completePendingEntry（其内含 DEC-138 / 139 校验）。
 */
import { sql, type Tx } from '@italent/db';
import {
  ENTRY_STATUS,
  ENTRY_REMARK_MAX,
  type EntryAction,
  type EntryCancelReason,
  type EntryEditEmployType,
  type EntryStatusCode,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { changePendingEntryStatus, lockPendingEntry } from './employee-status.js';
import { businessDate } from './fields.js';
import { clearPendingProbation, loadPendingProbation, savePendingProbation } from './entry-probation.js';
import { bumpEmploymentBusiness, lockEmploymentEmployee, type LockedEmploymentBusiness } from './record-store.js';
import { transitionEmployment } from './transitions.js';
import type { EmploymentBusiness, EmploymentContext, EmploymentRecord } from './types.js';
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

interface ReplaceInput {
  readonly action: 'postpone' | 'edit';
  readonly effectiveDate: string;
  readonly entryStatus: EntryStatusCode;
  readonly probation: boolean | null;
  readonly employType?: EntryEditEmployType;
  readonly remark?: string;
}

/**
 * 改期 / 编辑换日期的共同内核：任职记录的生效日 / 入职日不可原地改（只追加版本链，AGENTS §2），所以 = 删除原待入职记录
 * 并按新日期、原业务类型 / 表单标识 / 字段重建（同事务）；记录 ID 随之变化，两条用日志的 previous_business_id 串起，
 * 待入职试用期（F-188）搬到新记录。后面还有任职记录或在途申请时，删除一步按既有口径拒绝，整笔回滚。
 * 重建后的入职状态由调用方定：改期恒为延期，编辑保持原值。
 *
 * 不联动 Offer（R2e8 / DEC-546）：编辑 / 改期不回写 Offer 拟入职日期；手动删除待入职不改 Offer 状态。BE-14 接 Offer 时遵守。
 */
async function replacePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  locked: { readonly business: LockedEmploymentBusiness; readonly record: EmploymentRecord },
  input: ReplaceInput,
): Promise<EmploymentBusiness> {
  const { business, record } = locked;
  await transitionEmployment(tx, ctx, { id: record.id, action: 'delete' });
  await clearPendingProbation(tx, ctx, record.id);
  const employee = await lockEmploymentEmployee(tx, ctx, record.employeeId);
  const created = await createEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: employee.revision },
    record.employeeId,
    {
      // 保留原业务类型（hire / rehire / retire_rehire）与表单标识：重聘、返聘改期后仍是重聘、返聘
      kind: record.kind,
      mode: 'direct',
      formId: business.payload.formId,
      effectiveDate: input.effectiveDate,
      fields: input.employType ? { ...record.fields, employType: input.employType } : record.fields,
      customFields: record.customFields,
    },
    {
      entry: {
        pendingEntry: true,
        entryStatus: input.entryStatus,
        ...(input.probation === null ? {} : { probation: input.probation }),
      },
    },
  );
  await logEntryAction(tx, ctx, {
    employeeId: record.employeeId,
    businessId: created.id,
    previousBusinessId: record.id,
    action: input.action,
    remark: input.remark,
    fromDate: record.effectiveDate,
    toDate: input.effectiveDate,
  });
  await auditEmployment(
    tx,
    ctx,
    `employment.entry.${input.action}`,
    'employment-business',
    created.id,
    {
      businessId: record.id,
      effectiveDate: record.effectiveDate,
      entryStatus: record.entryStatus,
      ...(input.employType ? { employType: record.fields.employType } : {}),
    },
    {
      businessId: created.id,
      effectiveDate: input.effectiveDate,
      entryStatus: input.entryStatus,
      ...(input.employType ? { employType: input.employType } : {}),
    },
  );
  return created;
}

/** 改期入职（EN-R8）：入职日期必填、备注可选，入职状态变“延期”；已取消入职改期即恢复。 */
export async function postponePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: { readonly effectiveDate: string; readonly remark?: string },
): Promise<EmploymentBusiness> {
  assertRemark(input.remark);
  const effectiveDate = businessDate(input.effectiveDate);
  const locked = await lockPendingEntry(tx, ctx, recordId);
  if (effectiveDate === locked.record.effectiveDate && locked.record.entryStatus !== ENTRY_STATUS.cancelled)
    throw new AppError('VALIDATION_FAILED', '改期后的入职日期不能与原入职日期相同', { reason: 'ENTRY_DATE_UNCHANGED' });
  return replacePendingEntry(tx, ctx, locked, {
    action: 'postpone',
    effectiveDate,
    entryStatus: ENTRY_STATUS.postponed,
    probation: await loadPendingProbation(tx, ctx, recordId),
    remark: input.remark,
  });
}

/**
 * 编辑待入职（F-188，DEC-546② R2e8 行内“编辑”；R2e9 起可改雇佣关系）：计划入职日期（允许过去日期）+ 是否有试用期（必填）
 * + 雇佣关系（可选，内部员工 / 实习生，不传不改）。入职状态保持原值（正常 / 延期 / 取消都不变，与改期入职变“延期”不同）。
 * 日期和雇佣关系都没变：只更新试用期（记录 ID 不变，revision +1，不写动作日志，字段级审计记变更）；
 * 日期或雇佣关系变了：任职记录不可原地改这两项，走替换内核。其他任职字段仍走 PATCH /records/:id。
 * 合同起止日期不联动：待入职阶段没有合同数据（合同在办理入职时才生成），由 F-194 补（DEC-550）。
 */
export async function editPendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: { readonly effectiveDate: string; readonly probation: boolean; readonly employType?: EntryEditEmployType },
): Promise<EmploymentBusiness> {
  const effectiveDate = businessDate(input.effectiveDate);
  const locked = await lockPendingEntry(tx, ctx, recordId);
  const { business, record } = locked;
  const entryStatus = record.entryStatus ?? ENTRY_STATUS.normal;
  const employType =
    input.employType !== undefined && input.employType !== record.fields.employType ? input.employType : undefined;
  if (effectiveDate !== record.effectiveDate || employType !== undefined)
    return replacePendingEntry(tx, ctx, locked, {
      action: 'edit',
      effectiveDate,
      entryStatus,
      probation: input.probation,
      employType,
    });
  const before = await loadPendingProbation(tx, ctx, recordId);
  await savePendingProbation(tx, ctx, record.employeeId, recordId, input.probation);
  await bumpEmploymentBusiness(tx, ctx, business);
  await auditEmployment(
    tx,
    ctx,
    'employment.entry.edit',
    'employment-business',
    recordId,
    { probation: before },
    {
      probation: input.probation,
    },
  );
  return requireSavedBusiness(tx, ctx, recordId);
}

/**
 * 删除待入职（EN-R14，不可恢复）：只删待入职记录本身，已入职记录一律拒绝（NOT_PENDING_ENTRY）；人员主档保留（DEC-540）。
 * 同一内核也是“Offer 失效时删除待入职”的领域端口（F-171 / DEC-529，由 BE-14 在 Offer 侧调用）。
 * 手动删除待入职不改 Offer 状态（R2e8 / DEC-546），BE-14 不得因此回写 Offer。
 */
export async function deletePendingEntry(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
): Promise<EmploymentBusiness> {
  await lockPendingEntry(tx, ctx, recordId);
  const deleted = await transitionEmployment(tx, ctx, { id: recordId, action: 'delete' });
  await clearPendingProbation(tx, ctx, recordId);
  return deleted;
}
