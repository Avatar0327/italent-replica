/** DEC-137 / `10` §17：复制插入点的任职快照；不应用表单继承矩阵，也不做值匹配向后更新。 */
import { randomUUID } from 'node:crypto';
import { type Tx } from '@italent/db';
import { addDays } from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditEmployment, requireLinkedEmploymentRecord } from './context.js';
import { personnelHooks } from './personnel-hooks.js';
import { findPredecessor } from './read-model.js';
import { bumpEmploymentEmployee, insertEmploymentRow, lockEmploymentEmployee } from './record-store.js';
import { employmentTimelineNeighbors, insertEmploymentTimeline } from './timeline.js';
import { appendEmploymentPayload, appendEmploymentState } from './write-service.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

/** 调用方已按 UUID 锁住整个批次的员工，再锁组织；此端口不启动独立事务。 */
export async function appendOrgAdjustment(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  effectiveDate: string,
  organizationId: string,
) {
  const employee = await lockEmploymentEmployee(tx, ctx, employeeId);
  const previous = await findPredecessor(tx, ctx.tenantId, employeeId, effectiveDate);
  if (!previous || ['leave', 'retirement'].includes(previous.kind))
    throw new AppError('CONFLICT', '组织调整人员任职已变化，请刷新后重提');
  // 前一条的区间会被截断；按统一可见性判定整单拒绝，不把范围外员工静默漏掉（DEC-178）。
  await requireLinkedEmploymentRecord(tx, ctx, employeeId, previous.fields.departmentId, previous.id);
  const id = randomUUID();
  const { next } = await employmentTimelineNeighbors(tx, ctx, employeeId, effectiveDate);
  const now = ctx.now.toISOString();
  await insertEmploymentRow(tx, 'employment_business_objects', {
    id,
    tenantId: ctx.tenantId,
    employeeId,
    revision: 1,
    createdAt: now,
  });
  const input = {
    kind: 'org_adjustment' as const,
    mode: 'direct' as const,
    effectiveDate,
    lastWorkDate: null,
    formId: 'standard',
    fields: {},
    customFields: {},
  };
  const prepared = adjustmentSnapshot(previous, effectiveDate);
  const payload = await appendEmploymentPayload(tx, ctx, employeeId, id, 1, input, prepared, null, previous.staffId);
  await insertEmploymentRow(tx, 'employment_records', {
    ...previous.fields,
    id,
    tenantId: ctx.tenantId,
    employeeId,
    payloadVersionId: payload.id,
    staffId: previous.staffId,
    entryDate: previous.entryDate,
    kind: 'org_adjustment',
    changeType: null,
    startDate: effectiveDate,
    lastWorkDate: null,
    serviceType: 'primary',
    isInserted: !!next,
    inheritanceSourceId: previous.id,
    customFields: previous.customFields,
    createdAt: now,
  });
  await insertEmploymentTimeline(tx, ctx, employeeId, id, previous.staffId, effectiveDate);
  await appendEmploymentState(
    tx,
    ctx,
    {
      id,
      employeeId,
      revision: 1,
      employee,
      payload,
      state: 'effective',
      eventNo: 0,
    },
    'effective',
  );
  await bumpEmploymentEmployee(tx, ctx, employee);
  const after = { ...previous.fields, customFields: previous.customFields, kind: 'org_adjustment', effectiveDate };
  await auditEmployment(tx, ctx, 'employment.business.create', 'employment-business', id, null, after);
  await auditEmployment(tx, ctx, 'employment.record.create', 'employment-record', id, null, after, payload.id, {
    organizationId,
  });
  await auditAdjustmentInterval(tx, ctx, id, previous, effectiveDate);
  await personnelHooks.sync(tx, ctx, employeeId, id, 'org_adjustment', effectiveDate);
  await personnelHooks.sync(tx, ctx, employeeId, previous.id, previous.kind, previous.effectiveDate);
}

async function auditAdjustmentInterval(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  previous: EmploymentRecord,
  effectiveDate: string,
) {
  await auditEmployment(
    tx,
    ctx,
    'employment.org-adjustment.interval',
    'employment-record',
    previous.id,
    { stopDate: previous.stopDate },
    { stopDate: addDays(effectiveDate, -1), triggerBusinessId: id },
  );
}

function adjustmentSnapshot(previous: EmploymentRecord, effectiveDate: string) {
  return {
    effectiveDate,
    fields: previous.fields,
    customFields: previous.customFields,
    sourceRecordId: previous.id,
    sourceStaffId: previous.staffId,
    deferredFieldCodes: [],
    explicitFieldCodes: [],
    formSnapshot: {
      id: 'standard',
      group: 'org_adjustment' as const,
      startsNewCycle: false,
      customMode: 'readonly' as const,
      customInheritance: {},
      fieldModes: {},
      copiesPredecessor: true,
    },
  };
}
