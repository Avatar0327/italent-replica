import { assertRequiredTransferFields } from '../transfer/required-fields.js';
import { personnelHooks } from './personnel-hooks.js';
import { type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { getCustomFieldsForInheritance } from './configuration.js';
import { auditEmployment, requireScopedEmploymentObject } from './context.js';
import { normalizeBusinessPatch, validateCustomValue } from './fields.js';
import { isForwardEditSupported, type ForwardEditEntry, type ForwardFieldChange } from './forward-rules.js';
import { appendForwardPayload } from './forward-store.js';
import { forwardUpdateEmployment } from './forward-update.js';
import { sequenceForNewPost } from './inheritance.js';
import { loadEmploymentRecord } from './read-model.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness } from './record-store.js';
import { validateEmploymentReferences } from './references.js';
import { recordWindow } from './reporting-cycle.js';
import { requireSavedBusiness } from './write-service.js';
import type { EmploymentBusinessPatch, EmploymentContext, EmploymentRecord, CustomFields } from './types.js';

export async function editedValues(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  patch: EmploymentBusinessPatch,
) {
  if (patch.effectiveDate !== undefined || patch.lastWorkDate !== undefined) {
    throw new AppError('VALIDATION_FAILED', '任职字段编辑入口不能重排生效日期', { reason: 'RECORD_DATE_IMMUTABLE' });
  }
  if (patch.fields && Object.hasOwn(patch.fields, 'employType')) {
    throw new AppError('VALIDATION_FAILED', '任职字段编辑不能变更雇佣关系', { reason: 'EMPLOY_TYPE_NOT_ALLOWED' });
  }
  const customFields: Record<string, CustomFields[string]> = { ...record.customFields };
  const definitions = await getCustomFieldsForInheritance(tx, ctx.tenantId);
  for (const [id, value] of Object.entries(patch.customFields ?? {})) {
    const definition = definitions.find((field) => field.id === id);
    if (!definition) throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户任职对象');
    customFields[id] = validateCustomValue(value, definition.valueType);
  }
  const sequenceId = await sequenceForNewPost(tx, ctx.tenantId, patch.fields ?? {}, record.effectiveDate);
  const fields = { ...record.fields, ...patch.fields, ...(sequenceId ? { sequenceId } : {}) };
  await requireScopedEmploymentObject(tx, ctx, record.employeeId, record.fields.departmentId, record.id);
  await requireScopedEmploymentObject(tx, ctx, record.employeeId, fields.departmentId, record.id);
  return { fields, customFields };
}

/** 内部编辑端口；页面、人员、交接的入口接入时保留真实 entry，不模拟审批权限。 */
export async function editEmploymentRecord(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  input: EmploymentBusinessPatch,
  entry: ForwardEditEntry = 'api',
  options: { forwardUpdate?: boolean } = {},
) {
  const patch = normalizeBusinessPatch(input);
  const business = await lockEmploymentBusiness(tx, ctx, id);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, id, today);
  if (business.state !== 'effective' || !record) throw new AppError('CONFLICT', '只能编辑有效任职记录');
  const after = await editedValues(tx, ctx, record, patch);
  assertRequiredTransferFields(record.kind, business.payload.formSnapshot, after.fields);
  if (
    after.fields.jobNumber !== null &&
    after.fields.jobNumber.toLowerCase() !== business.employee.code.toLowerCase()
  ) {
    throw new AppError('VALIDATION_FAILED', '任职工号必须等于员工主档工号');
  }
  const reporting = await editedRecordReporting(tx, ctx, record, patch);
  await validateEmploymentReferences(tx, ctx, after.fields, record.effectiveDate, reporting);
  const beforeAudit = { ...record.fields, ...customAudit(record.customFields) };
  const afterAudit = { ...after.fields, ...customAudit(after.customFields) };
  const changes: ForwardFieldChange[] = Object.entries(afterAudit)
    .filter(([field, value]) => beforeAudit[field as keyof typeof beforeAudit] !== value)
    .map(([field, value]) => ({ field, before: beforeAudit[field as keyof typeof beforeAudit] ?? null, after: value }));
  if (!changes.length) return requireSavedBusiness(tx, ctx, id);
  business.payload = await appendForwardPayload(tx, ctx, business.payload, after, id, true, changes);
  await auditEmployment(tx, ctx, 'employment.record.edit', 'employment-record', id, beforeAudit, afterAudit);
  if (options.forwardUpdate !== false && isForwardEditSupported({ ...record, entry, today })) {
    await forwardUpdateEmployment(tx, ctx, {
      employeeId: business.employeeId,
      businessId: id,
      staffId: record.staffId,
      effectiveDate: record.effectiveDate,
      before: record,
      after,
    });
  }
  await personnelHooks.sync(tx, ctx, business.employeeId, id, record.kind, record.effectiveDate);
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, id);
}

/**
 * 编辑改了直线经理时，按被编辑记录在时间轴上实际生效的区间校验循环汇报（DEC-108，PR #54 P2-B）：被同日在后的
 * 记录取代的，区间为空、不校验；随之被向后修改的后续记录由 forward-update 按各自的区间逐条校验。
 */
export async function editedRecordReporting(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  patch: EmploymentBusinessPatch,
) {
  if (!patch.fields || !Object.hasOwn(patch.fields, 'directManagerId')) return undefined;
  return { employeeId: record.employeeId, window: await recordWindow(tx, ctx.tenantId, record.id) };
}

function customAudit(fields: CustomFields): Record<string, CustomFields[string]> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [`custom:${key}`, value]));
}
