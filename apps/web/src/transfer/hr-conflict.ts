/**
 * #350 第 1 轮 P2-2：HR 调动写入接 F-142 内核的“重读 → 核对差异 → 重提”（DEC-502①）。
 * 命令的对象是员工任职记录：版本取预览的 employeeRevision（If-Match），对象值取预览的“变更前”（当前任职记录），
 * 他人改动任职后核对的正是这份值；表单字段是用户在其上的改动（model.fields / customFields）。
 */
import type { Latest, Values } from '../foundation/forms/store.js';
import { presetLabels } from './messages.js';
import type { FieldValues, TransferFormModel, TransferPreview } from './types.js';

const prefixed = (source: 'preset' | 'custom', values: FieldValues) =>
  Object.fromEntries(Object.entries(values).map(([code, value]) => [`${source}:${code}`, value]));

/** 预览 → 内核的最新记录；预览带回的员工与所选不符时按读取失败处理。 */
export function previewRecord(employeeId: string, preview: TransferPreview & { employeeId?: unknown }): Latest {
  if (preview.employeeId !== undefined && preview.employeeId !== employeeId) throw new Error('invalid preview');
  const before = preview.before ?? { fields: {}, customFields: {} };
  return {
    id: employeeId,
    revision: preview.employeeRevision,
    values: { ...prefixed('preset', before.fields), ...prefixed('custom', before.customFields) },
  };
}
export const editableKeys = (preview: TransferPreview) =>
  Object.entries(preview.form.fieldModes)
    .filter(([, mode]) => mode === 'editable')
    .map(([key]) => key);
/** 表单草稿 = 当前记录 + 用户改动。 */
export function draftValues(model: TransferFormModel, record: Latest): Values {
  return { ...record.values, ...prefixed('preset', model.fields), ...prefixed('custom', model.customFields) };
}
export function fieldLabels(preview: TransferPreview | null): Record<string, string> {
  const custom = preview?.form.customFields ?? [];
  return {
    ...Object.fromEntries(Object.entries(presetLabels).map(([code, label]) => [`preset:${code}`, label])),
    ...Object.fromEntries(custom.map((field) => [`custom:${field.id}`, field.name])),
  };
}

const editableOnly = (source: 'preset' | 'custom', values: FieldValues, { form }: TransferPreview) =>
  Object.fromEntries(Object.entries(values).filter(([code]) => form.fieldModes[`${source}:${code}`] === 'editable'));
/**
 * 核对差异后换上重读的预览：用户改过、且在最新预览里仍可编辑的字段保留，其余取最新预览（claude_fe_rules b）。
 * 重读期间换了人则不动表单。
 */
export function withReread<T extends Partial<TransferFormModel>>(
  model: TransferFormModel,
  employeeId: string,
  loaded: T & { preview: TransferPreview },
): TransferFormModel {
  if (model.employeeId !== employeeId) return model;
  return {
    ...model,
    ...loaded,
    fields: editableOnly('preset', model.fields, loaded.preview),
    customFields: editableOnly('custom', model.customFields, loaded.preview),
  };
}
