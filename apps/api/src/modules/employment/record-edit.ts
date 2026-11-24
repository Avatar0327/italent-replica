import { affectsEstablishmentOccupancy } from '../establishment/employment-check.js';
import { assertNotPausedByOrgAdjustment } from '../org-adjustment/pause.js';
import { reconcileCompletion } from '../transfer/completion.js';
import { assertEstablishmentCapacity, type EstablishmentWarning } from './activation-checks.js';
import { lockTransferBusiness } from './transfer-locks.js';
import { queueTransferLinkage, validateTransferSubordinates } from './transfer-linkage.js';
import { assertRequiredTransferFields } from '../transfer/required-fields.js';
import { personnelHooks } from './personnel-hooks.js';
import { type Tx } from '@italent/db';
import {
  changedInputFields,
  requestInputFields,
  SAME_VALUE_CONFIRMATION,
  tenantLocalDate,
  type FieldOriginKind,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { getCustomFieldsForInheritance } from './configuration.js';
import { auditEmployment, requireScopedEmploymentObject } from './context.js';
import { isExitKind, requireExitPermission } from './exit-gate.js';
import { normalizeBusinessPatch, validateCustomValue } from './fields.js';
import {
  isForwardEditSupported,
  type ForwardEditEntry,
  type ForwardFieldChange,
  type ForwardValues,
} from './forward-rules.js';
import { appendForwardPayload, forwardFieldCode, systemForwardOrigins } from './forward-store.js';
import { loadFieldOrigins, type FieldOriginDraft } from './field-origin-store.js';
import { appendPayloadFieldOrigins, originActorKind } from './field-origin-write.js';
import { forwardUpdateEmployment } from './forward-update.js';
import { sequenceForNewPost } from './inheritance.js';
import { loadEmploymentRecord } from './read-model.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness, type LockedEmploymentBusiness } from './record-store.js';
import { assertEmploymentDepartmentAvailable, validateEmploymentReferences } from './references.js';
import { ENTRY_KINDS, isPendingEntryRecord } from './employee-status.js';
import { entrySourceEvents } from './entry-source-events.js';
import { validateSelectedEmploymentType } from './employment-types.js';
import { validateSelectedEmploymentForm } from './employment-forms.js';
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
    customFields[id] = validateCustomValue(value, definition.valueType, definition.options, record.customFields[id]);
  }
  const hasNamedChanges = changedInputFields(record, patch).size > 0;
  const sequenceId = await sequenceForNewPost(
    tx,
    ctx.tenantId,
    patch.fields ?? {},
    record.effectiveDate,
    record.fields.postId,
  );
  const fields = { ...record.fields, ...patch.fields, ...(sequenceId ? { sequenceId } : {}) };
  await requireScopedEmploymentObject(tx, ctx, record.employeeId, record.fields.departmentId, record.id);
  await requireScopedEmploymentObject(tx, ctx, record.employeeId, fields.departmentId, record.id);
  await validateSelectedEmploymentType(tx, ctx.tenantId, fields.employmentType, record.fields.employmentType);
  await validateSelectedEmploymentForm(tx, ctx.tenantId, fields.employmentForm, record.fields.employmentForm);
  return { values: { fields, customFields }, hasNamedChanges };
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
  const { linkageDate } = options;
  const patch = normalizeBusinessPatch(input);
  await lockTransferBusiness(tx, ctx, id);
  const business = await lockEmploymentBusiness(tx, ctx, id);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, id, today);
  if (business.state !== 'effective' || !record) throw new AppError('CONFLICT', '只能编辑有效任职记录');
  // R2-T03 §4A：编辑离职 / 退休记录需 DimissionEdit（页面、批量、导入编辑行同一端口）；日期键仍由 editedValues 以 RECORD_DATE_IMMUTABLE 拒绝
  if (isExitKind(record.kind))
    await requireExitPermission(ctx, 'update', { employeeId: record.employeeId, kind: record.kind, patch });
  const { values: after, hasNamedChanges } = await editedValues(tx, ctx, record, patch);
  // R2-T08 §7.6：员工主部门、原部门或新部门正在执行组织调整时 409（页面、批量、导入编辑同一端口；离职 / 退休不判）。
  if (!isExitKind(record.kind)) {
    const departmentIds = [record.fields.departmentId, after.fields.departmentId];
    await assertNotPausedByOrgAdjustment(tx, ctx, { employeeId: record.employeeId, departmentIds, date: today });
  }
  if (record.kind === 'transfer' && patch.fields && Object.hasOwn(patch.fields, 'addedSubordinateIds'))
    await validateTransferSubordinates(tx, ctx, record.employeeId, after.fields, record.effectiveDate);
  assertRequiredTransferFields(record.kind, business.payload.formSnapshot, after.fields);
  // F-493 S1：员工主档无工号时，任职工号只能为空
  if (
    after.fields.jobNumber !== null &&
    (business.employee.code === null || after.fields.jobNumber.toLowerCase() !== business.employee.code.toLowerCase())
  ) {
    throw new AppError('VALIDATION_FAILED', '任职工号必须等于员工主档工号');
  }
  const reporting = await editedRecordReporting(tx, ctx, record, patch);
  if (reporting?.window && linkageDate) reporting.window = { ...reporting.window, from: linkageDate };
  // DEC-138 / 139：编辑待入职与添加、办理入职共用入职日期 × 部门校验
  if (isPendingEntryRecord(record))
    await assertEmploymentDepartmentAvailable(tx, ctx, after.fields.departmentId, record.effectiveDate, true);
  await validateEmploymentReferences(tx, ctx, after.fields, record.effectiveDate, reporting, linkageDate);
  const { beforeAudit, afterAudit, changes } = recordEditDiff(record, after, hasNamedChanges);
  const origins = await editOrigins(tx, ctx, { id, business, record }, patch, after.fields, changes, linkageDate);
  if (!changes.length) return requireSavedBusiness(tx, ctx, id);
  // REQ-EMP-003 / 07 A7：历史、兼职、批量编辑只改本记录不传播；控编投影按同一判断，不模拟不会发生的传播（S1-P2-04）。
  const propagates = options.forwardUpdate !== false && isForwardEditSupported({ ...record, entry, today });
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
        propagates,
      },
      entry === 'import' ? (options.establishmentWarnings ?? []) : undefined,
    );
  business.payload = await appendForwardPayload(tx, ctx, business.payload, after, id, true, changes, origins);
  await auditEmployment(tx, ctx, 'employment.record.edit', 'employment-record', id, beforeAudit, afterAudit);
  if (propagates) {
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
  await bumpAndNotifyEntry(tx, ctx, business, record);
  return requireSavedBusiness(tx, ctx, id);
}

function recordEditDiff(record: ForwardValues, after: ForwardValues, hasNamedChanges: boolean) {
  const beforeAudit = { ...record.fields, ...customAudit(record.customFields) };
  // §4.4.4：先按请求点名的字段判定确认意图，之后才计算真正编辑时的派生差异。
  if (!hasNamedChanges) return { beforeAudit, afterAudit: beforeAudit, changes: [] };
  const afterAudit = { ...after.fields, ...customAudit(after.customFields) };
  const changes: ForwardFieldChange[] = Object.entries(afterAudit)
    .filter(
      ([field, value]) =>
        JSON.stringify(beforeAudit[field as keyof typeof beforeAudit] ?? null) !== JSON.stringify(value),
    )
    .map(([field, value]) => ({ field, before: beforeAudit[field as keyof typeof beforeAudit] ?? null, after: value }));
  return { beforeAudit, afterAudit, changes };
}

async function editOrigins(
  tx: Tx,
  ctx: EmploymentContext,
  target: { id: string; business: LockedEmploymentBusiness; record: EmploymentRecord },
  patch: EmploymentBusinessPatch,
  fields: EmploymentRecord['fields'],
  changes: readonly ForwardFieldChange[],
  linkageDate?: string,
): Promise<FieldOriginDraft[]> {
  const { id, business, record } = target;
  const linkage = linkageDate !== undefined;
  if (linkage || originActorKind(ctx, business, {}) === 'system-input') {
    return systemForwardOrigins(
      changes,
      linkage ? 'employment.linkage' : 'employment.record.edit',
      linkage ? undefined : id,
    );
  }
  const named = requestInputFields(patch);
  const confirmed = await confirmedRecordOrigins(tx, ctx, record, named, changes);
  if (changes.length) return [...editedRecordOrigins(changes, named, fields, id), ...confirmed];
  if (named.size) {
    await appendPayloadFieldOrigins(tx, ctx, business.payload, id, confirmed);
    await auditEmployment(
      tx,
      ctx,
      'employment.record.intent_confirmed',
      'employment-record',
      id,
      null,
      null,
      business.payload.id,
      { fields: [...named] },
    );
  }
  return confirmed;
}

function editedRecordOrigins(
  changes: readonly ForwardFieldChange[],
  named: ReadonlySet<string>,
  fields: EmploymentRecord['fields'],
  businessId: string,
): FieldOriginDraft[] {
  const origins: FieldOriginDraft[] = [];
  for (const { field, after } of changes) {
    const fieldCode = forwardFieldCode(field);
    if (named.has(fieldCode)) {
      origins.push({ fieldCode, originKind: 'hr-record', value: after });
    } else if (field === 'sequenceId' && fields.postId) {
      // 未点名序列时，editedValues 中唯一能改写序列的是 DEC-107 职务派生。
      origins.push({
        fieldCode,
        originKind: 'derive-edit',
        value: after,
        derivationRule: 'post-sequence',
        referenceId: fields.postId,
        sourceBusinessId: businessId,
      });
    }
  }
  return origins;
}

const MANUAL_ORIGINS: ReadonlySet<FieldOriginKind> = new Set([
  'hr-record',
  'hr-input',
  'approval-edit',
  'employee-input',
  'retain',
]);

async function confirmedRecordOrigins(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  named: ReadonlySet<string>,
  changes: readonly ForwardFieldChange[],
) {
  // DEC-252③：只把稀疏请求里点名的同值字段固定为人工覆盖。
  const changed = new Set(changes.map(({ field }) => forwardFieldCode(field)));
  const same = [...named].filter((fieldCode) => !changed.has(fieldCode));
  const states = await loadFieldOrigins(tx, ctx, record.id, same);
  const rows: FieldOriginDraft[] = [];
  for (const fieldCode of same) {
    const value = fieldCode.startsWith('custom:')
      ? (record.customFields[fieldCode.slice('custom:'.length)] ?? null)
      : record.fields[fieldCode.slice('preset:'.length) as keyof EmploymentRecord['fields']];
    const writer = states.get(fieldCode)?.lastWriter;
    if (writer && MANUAL_ORIGINS.has(writer.originKind) && JSON.stringify(writer.value) === JSON.stringify(value))
      continue;
    rows.push({ fieldCode, originKind: 'hr-record', value, reason: SAME_VALUE_CONFIRMATION });
  }
  return rows;
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

/** F-505 §6.2：实际内容编辑才到这里。办理后仍保留原记录的入职状态，已有任务要随原来源变更撤销。 */
export async function bumpAndNotifyEntry(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  record: EmploymentRecord,
) {
  await bumpEmploymentBusiness(tx, ctx, business);
  if (!ENTRY_KINDS.includes(record.kind) || record.entryStatus === null) return;
  await entrySourceEvents.emit(tx, ctx, {
    source: 'entry',
    sourceId: business.id,
    change: 'changed',
    revision: business.revision,
  });
}
