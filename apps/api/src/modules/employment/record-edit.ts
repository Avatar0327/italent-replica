import { affectsEstablishmentOccupancy } from '../establishment/employment-check.js';
import { reconcileCompletion } from '../transfer/completion.js';
import { assertEstablishmentCapacity, type EstablishmentWarning } from './activation-checks.js';
import { lockTransferBusiness } from './transfer-locks.js';
import { queueTransferLinkage, validateTransferSubordinates } from './transfer-linkage.js';
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
import { sequenceForNewPost, type FieldDerivation } from './field-derivations.js';
import { loadEmploymentRecord } from './read-model.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness, type EmploymentPayloadRow } from './record-store.js';
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
  options: { forwardUpdate?: boolean; linkageDate?: string; establishmentWarnings?: EstablishmentWarning[] } = {},
) {
  const patch = normalizeBusinessPatch(input);
  await lockTransferBusiness(tx, ctx, id);
  const business = await lockEmploymentBusiness(tx, ctx, id);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, id, today);
  if (business.state !== 'effective' || !record) throw new AppError('CONFLICT', '只能编辑有效任职记录');
  const after = await editedValues(tx, ctx, record, patch);
  if (record.kind === 'transfer' && patch.fields && Object.hasOwn(patch.fields, 'addedSubordinateIds'))
    await validateTransferSubordinates(tx, ctx, record.employeeId, after.fields, record.effectiveDate);
  assertRequiredTransferFields(record.kind, business.payload.formSnapshot, after.fields);
  if (
    after.fields.jobNumber !== null &&
    after.fields.jobNumber.toLowerCase() !== business.employee.code.toLowerCase()
  ) {
    throw new AppError('VALIDATION_FAILED', '任职工号必须等于员工主档工号');
  }
  const reporting = await editedRecordReporting(tx, ctx, record, patch);
  if (reporting?.window && options.linkageDate) reporting.window = { ...reporting.window, from: options.linkageDate };
  await validateEmploymentReferences(tx, ctx, after.fields, record.effectiveDate, reporting, options.linkageDate);
  const beforeAudit = { ...record.fields, ...customAudit(record.customFields) };
  const afterAudit = { ...after.fields, ...customAudit(after.customFields) };
  const changes: ForwardFieldChange[] = Object.entries(afterAudit)
    .filter(
      ([field, value]) => JSON.stringify(beforeAudit[field as keyof typeof beforeAudit]) !== JSON.stringify(value),
    )
    .map(([field, value]) => ({ field, before: beforeAudit[field as keyof typeof beforeAudit] ?? null, after: value }));
  const inputCodes = recordEditCodes(patch);
  // 显式同值更正也有命令意图；迟到重建时不能将其误作前驱继承。
  if (!changes.length && !(record.kind === 'org_adjustment' && inputCodes.length))
    return requireSavedBusiness(tx, ctx, id);
  if (await affectsEstablishmentOccupancy(tx, ctx, record.fields, after.fields, record.effectiveDate))
    await assertEstablishmentCapacity(
      tx,
      ctx,
      {
        businessId: id,
        employeeId: record.employeeId,
        kind: 'transfer',
        effectiveDate: record.effectiveDate,
        fields: after.fields,
        departmentId: after.fields.departmentId,
        positionId: after.fields.positionId,
      },
      entry === 'import' ? (options.establishmentWarnings ?? []) : undefined,
    );
  business.payload = await appendEditedPayload(tx, ctx, business.payload, record, patch, after, changes);
  if (options.forwardUpdate !== false && isForwardEditSupported({ ...record, entry, today })) {
    await forwardUpdateEmployment(tx, ctx, {
      employeeId: business.employeeId,
      businessId: id,
      staffId: record.staffId,
      effectiveDate: record.effectiveDate,
      before: record,
      after,
      establishmentWarnings: entry === 'import' ? (options.establishmentWarnings ?? []) : undefined,
    });
  }
  if (record.effectiveDate > today)
    await queueTransferLinkage(tx, ctx, id, record.kind, after.fields, record.effectiveDate);
  await personnelHooks.sync(tx, ctx, business.employeeId, id, record.kind, record.effectiveDate);
  await reconcileCompletion(tx, ctx, business.employeeId);
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, id);
}

function recordEditCodes(patch: EmploymentBusinessPatch) {
  return [
    ...Object.keys(patch.fields ?? {}).map((field) => `preset:${field}`),
    ...Object.keys(patch.customFields ?? {}).map((field) => `custom:${field}`),
  ];
}

async function appendEditedPayload(
  tx: Tx,
  ctx: EmploymentContext,
  payload: EmploymentPayloadRow,
  record: EmploymentRecord,
  patch: EmploymentBusinessPatch,
  after: Pick<EmploymentRecord, 'fields' | 'customFields'>,
  changes: readonly ForwardFieldChange[],
) {
  const explicitFieldCodes = [...new Set([...payload.explicitFieldCodes, ...recordEditCodes(patch)])];
  const next = await appendForwardPayload(tx, ctx, { ...payload, explicitFieldCodes }, after, record.id, true, changes);
  await auditEmployment(
    tx,
    ctx,
    'employment.record.edit',
    'employment-record',
    record.id,
    { ...record.fields, ...customAudit(record.customFields) },
    { ...after.fields, ...customAudit(after.customFields) },
    next.id,
    await recordEditIntent(tx, ctx, record, patch),
  );
  return next;
}

/** 人工输入与本次职务派生分别保存，不能靠最终值与旧载荷的差异恢复命令。 */
async function recordEditIntent(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  patch: EmploymentBusinessPatch,
) {
  const derivations: FieldDerivation[] = [];
  const sequenceId = await sequenceForNewPost(tx, ctx.tenantId, patch.fields ?? {}, record.effectiveDate);
  if (sequenceId) derivations.push({ rule: 'post-sequence', referenceId: patch.fields?.postId ?? null });
  return {
    patch: { fields: patch.fields ?? {}, customFields: patch.customFields ?? {} },
    fieldDerivations: derivations,
  };
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
