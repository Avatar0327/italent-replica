/** F-140 §3.4：替代是一次命令；前单撤销与后继 approved 的整体 ΔO / ΔP 由上游统一校验。 */
import { exitRequests, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { remainingExitDuties } from './exit-replacement-plan.js';
import { assertEmployeeLocksHeld } from './transfer-locks.js';
import { cancelExit } from './exit-cancel.js';
import { confirmExit } from './exit-confirmation.js';
import { EXIT_GATE_PASS, loadExitRequest, type AckRecord } from './exit-gate.js';
import {
  lockEmploymentBusiness,
  lockEmploymentEmployee,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { appendEmploymentState, createEmploymentBusiness, requireSavedBusiness } from './write-service.js';
import { appendLinkageVersion } from '../transfer/linkage/store.js';
import type { EmploymentContext } from './types.js';
import type { DownstreamItem } from './exit-downstream.js';

export async function replaceExit(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  change: { oldPlan: string; effectiveDate: string; lastWorkDate: string | null },
  ack: AckRecord | null,
) {
  const old = await loadExitRequest(tx, ctx.tenantId, business.id);
  if (!old) throw new AppError('NOT_FOUND', '离职单不存在');
  await cancelExit(
    tx,
    { ...ctx, expectedRevision: business.revision },
    business.id,
    { reason: '人工改期到未来，生成后继离职单' },
    { replacementUntil: change.effectiveDate },
  );
  const employee = await lockEmploymentEmployee(tx, ctx, business.employeeId);
  const { employType: _employType, ...fields } = business.payload.fields;
  const created = await createEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: employee.revision },
    employee.id,
    {
      kind: 'leave',
      mode: business.payload.mode,
      lastWorkDate: change.lastWorkDate!,
      effectiveDate: change.effectiveDate,
      formId: business.payload.formId,
      fields,
      customFields: business.payload.customFields,
    },
    {
      exitPass: EXIT_GATE_PASS,
      rescheduledExit: true,
      ...(business.payload.changeType ? { changeType: business.payload.changeType } : {}),
    },
  );
  const successor = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: created.revision }, created.id);
  if (successor.state !== 'approved') await appendEmploymentState(tx, ctx, successor, 'approved');
  await tx.insert(exitRequests).values({
    ...old,
    businessId: created.id,
    preReleaseDate: null,
    supersedesBusinessId: business.id,
    pendingTransferAck: ack,
    createdAt: ctx.now,
  });
  await copyRemainingDuties(tx, ctx, business, created.id);
  await confirmExit(tx, ctx, {
    id: created.id,
    employeeId: employee.id,
    effectiveDate: change.effectiveDate,
    mode: business.payload.mode,
  });
  await auditEmployment(
    tx,
    ctx,
    'employment.leave.replanned',
    'employment-business',
    business.id,
    { plannedEffectiveDate: change.oldPlan },
    {
      plannedEffectiveDate: change.effectiveDate,
      successorBusinessId: created.id,
      versionNo: successor.payload.versionNo,
    },
  );
  return {
    next: successor.payload,
    successor: await requireSavedBusiness(tx, ctx, created.id),
    hints: [] as DownstreamItem[],
  };
}

/** 成功项按整条前单链排除；失败项保留失败证据但改为 superseded，使原重试端口自然拒绝。 */
async function copyRemainingDuties(tx: Tx, ctx: EmploymentContext, old: LockedEmploymentBusiness, successorId: string) {
  const remaining = await remainingExitDuties(tx, ctx.tenantId, old.id);
  if (!remaining) return;
  const { linkage, dutyTransfer } = remaining;
  await assertEmployeeLocksHeld(
    tx,
    dutyTransfer.subordinates.map((d) => d.employeeId),
  );
  const replaced = rowsOf<{ id: string }>(
    await tx.execute(sql`UPDATE transfer_linkage_items
    SET status='superseded',revision=revision+1 WHERE tenant_id=${ctx.tenantId} AND business_id=${old.id}::uuid
      AND status='failed' AND item_type IN ('duty_subordinate','duty_org_role') RETURNING id`),
  );
  if (replaced.length)
    await auditEmployment(
      tx,
      ctx,
      'transfer.linkage.save',
      'transfer-linkage',
      old.id,
      { status: 'failed', itemIds: replaced.map((r) => r.id) },
      { status: 'superseded', successorBusinessId: successorId },
    );
  if (!dutyTransfer.subordinates.length && !dutyTransfer.orgRoles.length) return;
  await appendLinkageVersion(
    tx,
    ctx,
    { businessId: successorId, employeeId: old.employeeId },
    { ...linkage.options, dutyTransfer },
  );
}
