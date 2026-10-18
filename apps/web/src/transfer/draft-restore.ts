/**
 * F-153（DEC-511）：他人调动申请暂存按人一份——重选同一人时按当前权限读取草稿带出，可点击清除。
 * 读取按真实接口形状核对（GET /businesses/:id、GET /transfers/:id/linkage）；回填走 F-142 内核（DEC-502①）。
 */
import { changedFields } from '../foundation/forms/values.js';
import { emptyLinkage } from './linkage-api.js';
import type { FieldMode, FieldValues, LinkageDraft, TransferCatalog, TransferFormModel } from './types.js';

export interface DraftSnapshot {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate?: string;
  readonly formId?: string;
  /** 以服务端暂存元数据为准，缺键时交用户重新确认。 */
  readonly transferTypeCode?: string;
  readonly fields: FieldValues;
  readonly customFields: FieldValues;
  readonly linkage: LinkageDraft;
}
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isAbsent = (value: unknown): value is null | undefined => value === null || value === undefined;
const optionalText = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
function invalid(): never {
  throw new Error('invalid transfer draft');
}

/** 单号、人员、revision、联动版本任一不符即读取失败；已不是草稿（他处已提交或作废）返回 null，不带出。 */
export function parseDraft(
  id: string,
  employeeId: string,
  business: unknown,
  linkage: unknown,
  transferTypeCode?: string,
): DraftSnapshot | null {
  if (
    !isObject(business) ||
    business.id !== id ||
    (business.employeeId !== undefined && business.employeeId !== employeeId)
  )
    invalid();
  if (business.status !== undefined && business.status !== 'draft') return null;
  if (!Number.isInteger(business.revision) || (business.fields !== undefined && !isObject(business.fields))) invalid();
  if (!isAbsent(business.customFields) && !isObject(business.customFields)) invalid();
  if (!isObject(linkage) || linkage.businessId !== id || linkage.revision !== business.revision) invalid();
  const effectiveDate = optionalText(business.effectiveDate);
  const formId = optionalText(business.formId);
  return {
    id,
    employeeId,
    ...(effectiveDate ? { effectiveDate } : {}),
    ...(formId ? { formId } : {}),
    ...(transferTypeCode ? { transferTypeCode } : {}),
    fields: (business.fields ?? {}) as FieldValues,
    customFields: (business.customFields ?? {}) as FieldValues,
    linkage: linkageFromOptions(linkage.options),
  };
}

function dutyLinkage(duty: unknown): Partial<LinkageDraft> {
  if (isAbsent(duty)) return {};
  if (!isObject(duty) || !Array.isArray(duty.subordinates) || !Array.isArray(duty.orgRoles)) invalid();
  const subordinates = duty.subordinates.filter(isObject);
  const orgRoles = duty.orgRoles.filter(isObject);
  const receivers = new Set([...subordinates, ...orgRoles].map((item) => item.receiverId));
  // 表单只能表达一个接收人；多个接收人无法如实带出，按读取失败处理而不是只带出一部分。
  if (receivers.size > 1 || [...receivers].some((receiver) => typeof receiver !== 'string')) invalid();
  return {
    dutyReceiverId: ([...receivers][0] as string | undefined) ?? '',
    dutySubordinateIds: subordinates.map((item) => String(item.employeeId)),
    transferDepartmentHead: orgRoles.some((item) => item.role === 'person_in_charge'),
  };
}
/** GET /transfers/:id/linkage 的 options → 表单联动草稿；被隐藏（未返回）的项保持默认。 */
export function linkageFromOptions(options: unknown): LinkageDraft {
  if (isAbsent(options)) return emptyLinkage;
  if (!isObject(options)) invalid();
  const { contract, onTrial, handover } = options;
  return {
    ...emptyLinkage,
    ...(isObject(contract) && typeof contract.targetId === 'string'
      ? {
          changeContract: true,
          contractTargetId: contract.targetId,
          contractFields: (isObject(contract.fields) ? contract.fields : {}) as LinkageDraft['contractFields'],
        }
      : {}),
    adjustSalary: options.adjustSalary === true,
    ...(isObject(onTrial) && Number.isInteger(onTrial.months)
      ? { onTrialMonths: onTrial.months as number, onTrialStartDate: optionalText(onTrial.startDate) ?? '' }
      : {}),
    ...(isObject(handover) && typeof handover.handoverPersonId === 'string'
      ? { handoverPersonId: handover.handoverPersonId }
      : {}),
    ...dutyLinkage(options.dutyTransfer),
  };
}

/** 服务端未返回类型时不从表单反推，交用户确认（F-181b / 附录 A(d)）。 */
export function draftTransferType(catalog: TransferCatalog, draft: DraftSnapshot): string | undefined {
  const matches = (type: TransferCatalog['types'][number]) => !draft.formId || type.formId === draft.formId;
  if (draft.transferTypeCode) {
    const stored = catalog.types.find((type) => type.code === draft.transferTypeCode);
    return stored && matches(stored) ? stored.code : undefined;
  }
  return undefined;
}

// 与 LinkageAccess 同一组权限编码：一组全部可编辑才带出暂存值，否则保持默认。
const linkageGroups: readonly { codes: readonly string[]; keys: readonly (keyof LinkageDraft)[] }[] = [
  { codes: ['isChangeContract', 'contractChange'], keys: ['changeContract', 'contractTargetId', 'contractFields'] },
  { codes: ['adjustSalary'], keys: ['adjustSalary'] },
  { codes: ['onTrialMonths'], keys: ['onTrialMonths'] },
  { codes: ['onTrialStartDate'], keys: ['onTrialStartDate'] },
  { codes: ['handoverPersonId'], keys: ['handoverPersonId'] },
  { codes: ['dutyTransfer'], keys: ['dutyReceiverId', 'dutySubordinateIds', 'transferDepartmentHead'] },
];
/**
 * 只带出当前可编辑的联动项：只读项在表单上改不回，而提交会原样带上联动草稿，
 * 带出后等于替用户重提一个他已无权修改的选项（保守取默认）。缺省权限清单沿用全字段契约。
 */
export function editableLinkage(catalog: TransferCatalog, linkage: LinkageDraft): LinkageDraft {
  const editable = catalog.editableFields;
  if (!editable) return linkage;
  const kept = linkageGroups
    .filter((group) => group.codes.every((code) => editable.includes(code)))
    .flatMap((group) => group.keys.map((key) => [key, linkage[key]] as const));
  return { ...emptyLinkage, ...Object.fromEntries(kept) };
}

function withoutPending(model: TransferFormModel): TransferFormModel {
  const { pendingDraft: _pending, ...rest } = model;
  return rest;
}
/**
 * 先定日期、类型与（可编辑的）联动；字段等对应日期与类型的预览到达后再回填（applyPendingDraft），
 * 因为“哪些字段当前可编辑”以服务端预览为准。人已换掉则不动表单。
 */
export function restoreDraft(model: TransferFormModel, draft: DraftSnapshot): TransferFormModel {
  if (model.employeeId !== draft.employeeId) return model;
  const effectiveDate = draft.effectiveDate ?? model.effectiveDate;
  const restoredType = draftTransferType(model.catalog, draft);
  const transferTypeCode = restoredType ?? '';
  const same = effectiveDate === model.effectiveDate && transferTypeCode === model.transferTypeCode;
  const next: TransferFormModel = {
    ...model,
    effectiveDate,
    transferTypeCode,
    typeConfirmation: !restoredType,
    reasonCode: same ? model.reasonCode : '',
    fields: {},
    customFields: {},
    ...(model.linkage ? { linkage: editableLinkage(model.catalog, draft.linkage) } : {}),
    pendingDraft: { employeeId: draft.employeeId, fields: draft.fields, customFields: draft.customFields },
  };
  return same && model.preview ? applyPendingDraft(next) : { ...next, preview: null };
}

/**
 * 目录（按生效日期）到达后定类型：当前类型仍在目录里则保留；带出中（等确认或等回填）的类型不在目录里时留空等用户选择，
 * 不默认成第一项；其余情况取第一项。
 */
export function catalogType(model: TransferFormModel, catalog: TransferCatalog) {
  if (catalog.types.some((type) => type.code === model.transferTypeCode))
    return { transferTypeCode: model.transferTypeCode, typeConfirmation: false };
  if (model.typeConfirmation || model.pendingDraft) return { transferTypeCode: '', typeConfirmation: true };
  return { transferTypeCode: catalog.types[0]?.code ?? '', typeConfirmation: false };
}

function editedValues(source: 'preset' | 'custom', draft: FieldValues, current: FieldValues, modes: Modes) {
  const editable = Object.keys(draft).filter((code) => modes[`${source}:${code}`] === 'editable');
  return Object.fromEntries(changedFields(draft, current, editable).map((code) => [code, draft[code]!]));
}
type Modes = Readonly<Record<string, FieldMode>>;
/** 只回填“当前可编辑且与预览不同”的字段（F-142 changedFields）；只读、隐藏与未改字段取预览。 */
export function applyPendingDraft(model: TransferFormModel): TransferFormModel {
  const pending = model.pendingDraft;
  if (!pending || !model.preview) return model;
  const rest = withoutPending(model);
  if (pending.employeeId !== model.employeeId) return rest;
  const { fieldModes } = model.preview.form;
  return {
    ...rest,
    fields: { ...rest.fields, ...editedValues('preset', pending.fields, model.preview.fields, fieldModes) },
    customFields: {
      ...rest.customFields,
      ...editedValues('custom', pending.customFields, model.preview.customFields, fieldModes),
    },
  };
}

/** 点击清除：回到空白表单（租户当天、默认类型、无联动），保留所选人员。 */
export function clearDraft(model: TransferFormModel): TransferFormModel {
  const effectiveDate = model.catalog.today ?? model.effectiveDate;
  const transferTypeCode = model.catalog.types[0]?.code ?? model.transferTypeCode;
  const same = effectiveDate === model.effectiveDate && transferTypeCode === model.transferTypeCode;
  return {
    ...withoutPending(model),
    effectiveDate,
    transferTypeCode,
    typeConfirmation: false,
    reasonCode: '',
    withEstablishment: false,
    fields: {},
    customFields: {},
    ...(model.linkage ? { linkage: emptyLinkage } : {}),
    ...(same ? {} : { preview: null }),
  };
}
