/** F-140b1：未生效离职人工改期的唯一编排入口（设计 §3.2；DEC-687 / 688）。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { addDays, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { lockEstablishment } from '../establishment/store.js';
import { auditActor } from '../../system-actor.js';
import { auditEmployment } from './context.js';
import { activateExit } from './exit-activation.js';
import { pendingActivations, recordActivationAttempt, type PendingActivation } from './activation-store.js';
import { loadOccupancy, assertOccupancyChange } from './exit-cancel-intervals.js';
import { runExitReplannedHooks } from './exit-confirmation.js';
import { probeRescheduleDownstream } from './exit-downstream.js';
import {
  assertActualLeaveDate,
  assertNoRegularizationInFlight,
  checkPendingTransferAck,
  disclose,
  loadExitRequest,
  requireExitPermission,
  saveAck,
} from './exit-gate.js';
import { lockExitOrganizationResources, lockOtherBusinessHeads } from './exit-void-applications.js';
import { normalizeEmploymentInput } from './fields.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { loadPlannedEffectiveDate } from './timeline.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentBusinessPatch, EmploymentContext } from './types.js';

export interface RescheduleOptions {
  readonly pendingTransferAck?: string;
  readonly confirmed?: boolean;
  readonly approvalEdit?: boolean;
  readonly actualLeaveDate?: string;
}

/** 先取齐参与员工闭包，再取本单；审批入口已经取齐时复用同一锁计划。 */
export async function lockExitForEdit(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT employee_id AS "employeeId" FROM employment_business_objects
    WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
  );
  if (!owner) throw new AppError('NOT_FOUND', '任职业务不存在');
  await lockTransferParticipants(tx, ctx, owner.employeeId);
  return lockEmploymentBusiness(tx, ctx, businessId);
}

/** DEC-688：只供改期的 §8A 使用；其它入口的逾期判定不变，也不豁免已落地联动失败。 */
export function transferBlockedByThisExit(item: PendingActivation, exitId: string): boolean {
  return (
    !item.materialized &&
    ((item.lastOutcome === 'failed' &&
      item.lastReason === 'REBUILD_REQUIRED' &&
      item.lastBlockerIds.includes(exitId)) ||
      (item.lastOutcome === 'suspended' && item.lastBlockedBy === exitId))
  );
}

export async function exitDateChange(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  patch: EmploymentBusinessPatch,
) {
  if (patch.lastWorkDate === undefined && patch.effectiveDate === undefined) return null;
  const oldPlan = await loadPlannedEffectiveDate(tx, ctx.tenantId, business.id, business.payload.effectiveDate);
  const normalized = normalizeEmploymentInput(ctx, {
    kind: business.payload.kind,
    mode: business.payload.mode,
    lastWorkDate: patch.lastWorkDate === undefined ? addDays(oldPlan, -1) : patch.lastWorkDate,
    ...(patch.effectiveDate === undefined ? {} : { effectiveDate: patch.effectiveDate }),
  });
  return normalized.effectiveDate === oldPlan ? null : { oldPlan, ...normalized };
}

/** caller 已在自己的权限链后持员工 / 业务锁；失败整个命令回滚，R6 自带保存点。 */
export async function rescheduleExit(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  patch: EmploymentBusinessPatch,
  options: RescheduleOptions = {},
) {
  await requireExitPermission(ctx, 'update', {
    employeeId: business.employeeId,
    business,
    patch,
    approvalEdit: options.approvalEdit,
  });
  const change = await exitDateChange(tx, ctx, business, patch);
  if (!change) return null;
  if (business.payload.kind !== 'leave' || !['draft', 'rejected', 'in_review', 'approved'].includes(business.state))
    throw new AppError('VALIDATION_FAILED', '当前状态不支持离职改期', { reason: 'EXIT_DATE_IMMUTABLE' });
  const exit = await loadExitRequest(tx, ctx.tenantId, business.id);
  if (!exit) throw new AppError('NOT_FOUND', '离职单不存在');
  const [cycle] = rowsOf<{ entryDate: string }>(
    await tx.execute(sql`
    SELECT entry_date::text AS "entryDate" FROM employment_cycles
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${business.employeeId}::uuid AND id=${exit.staffId}::uuid`),
  );
  if (!cycle || change.lastWorkDate! < cycle.entryDate)
    throw new AppError('VALIDATION_FAILED', '最后工作日不能早于本单所属周期的入职日期', {
      reason: 'EXIT_LAST_WORK_DATE_BEFORE_ENTRY',
      entryDate: cycle?.entryDate,
    });
  assertActualLeaveDate(options.actualLeaveDate ?? exit.actualLeaveDate ?? undefined, change.lastWorkDate);
  await lockOtherBusinessHeads(tx, ctx, business.employeeId, business.id);
  await lockExitOrganizationResources(tx, ctx, business.employeeId, business.id);
  await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const queue = await pendingActivations(tx, ctx, business.employeeId);
  const overdue = queue.filter(
    (item) =>
      item.kind === 'transfer' &&
      item.plannedDate < today &&
      !item.reminderOnly &&
      !transferBlockedByThisExit(item, business.id),
  );
  if (overdue.length)
    throw new AppError('CONFLICT', '存在已过计划生效日仍未执行的调动，请先处理', {
      reason: 'EXIT_LATE_TRANSFER_PENDING',
      ...(await disclose(
        tx,
        ctx,
        business.employeeId,
        overdue.map((item) => ({
          ...item,
          effectiveDate: item.plannedDate,
          extra: { materialized: item.materialized },
        })),
      )),
    });
  await assertNoRegularizationInFlight(tx, ctx, business.employeeId, change.lastWorkDate!);
  const ack = await checkPendingTransferAck(
    tx,
    ctx,
    business.employeeId,
    change.lastWorkDate!,
    options.pendingTransferAck,
    null,
  );
  const occupancy = await loadOccupancy(tx, ctx, business.employeeId);
  const previous = business.payload;
  const next = {
    ...previous,
    id: randomUUID(),
    previousVersionId: previous.id,
    versionNo: previous.versionNo + 1,
    effectiveDate: change.effectiveDate,
    lastWorkDate: change.lastWorkDate,
    triggerBusinessId: null,
    commandId: null,
    plannedEffectiveDate: change.effectiveDate,
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  business.payload = next;
  await bumpEmploymentBusiness(tx, ctx, business);
  await saveAck(tx, ctx, business.id, ack);
  await assertOccupancyChange(tx, ctx, business.employeeId, business.id, occupancy, options.confirmed === true);
  await auditEmployment(
    tx,
    ctx,
    'employment.leave.replanned',
    'employment-business',
    business.id,
    { plannedEffectiveDate: change.oldPlan },
    { plannedEffectiveDate: change.effectiveDate, versionNo: next.versionNo },
  );
  const detail = { fromPlanned: change.oldPlan, toPlanned: change.effectiveDate, versionNo: next.versionNo };
  for (const item of queue) {
    const reset =
      item.id === business.id
        ? ['failed', 'suspended'].includes(item.lastOutcome ?? '')
        : (item.lastOutcome === 'suspended' && item.lastBlockedBy === business.id) ||
          (item.lastOutcome === 'failed' &&
            item.lastReason === 'REBUILD_REQUIRED' &&
            item.lastBlockerIds.includes(business.id));
    if (reset)
      await recordActivationAttempt(
        tx,
        ctx,
        item,
        {
          outcome: 'replanned',
          trigger: 'retry',
          reason: 'REPLANNED',
          detail,
        },
        { bumpRevision: item.id !== business.id },
      );
  }
  if (business.state === 'approved' && change.effectiveDate <= today)
    await activateExit(tx, { ...ctx, expectedRevision: business.revision }, business.id, { trigger: 'approval' });
  await runExitReplannedHooks(tx, ctx, {
    tenantId: ctx.tenantId,
    employeeId: business.employeeId,
    businessId: business.id,
    fromPlanned: change.oldPlan,
    toPlanned: change.effectiveDate,
    versionNo: next.versionNo,
  });
  return business.state === 'approved'
    ? probeRescheduleDownstream(
        tx,
        ctx,
        business.employeeId,
        business.id,
        addDays(change.oldPlan, -1),
        change.lastWorkDate!,
      )
    : null;
}
