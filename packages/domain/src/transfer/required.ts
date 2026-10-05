import type { TransferFieldMode } from './catalog.js';

export interface TransferRequiredForm {
  readonly excludedAutofillFields?: readonly string[];
  readonly fieldModes: Readonly<Record<string, TransferFieldMode>>;
}

/** DEC-162：本场景不带出的可编辑字段必须显式填写；预览只展示，不执行保存校验。
 * TODO(需取证 Q-M0-65 / D-048)：原站仅部门必填，待差异决策；当前按 DEC-162，后续只在这里调整规则。
 */
export function requiredTransferFields(form: TransferRequiredForm): readonly string[] {
  return (form.excludedAutofillFields ?? []).filter((field) => form.fieldModes[`preset:${field}`] === 'editable');
}

export function missingTransferRequiredFields(
  form: TransferRequiredForm,
  submittedFields: Readonly<Record<string, unknown>>,
): readonly string[] {
  return requiredTransferFields(form).filter((field) => {
    const value = submittedFields[field];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
}
