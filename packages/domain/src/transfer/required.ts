import type { TransferFieldMode } from './catalog.js';

export interface TransferRequiredForm {
  readonly excludedAutofillFields?: readonly string[];
  readonly fieldModes: Readonly<Record<string, TransferFieldMode>>;
}

/** DEC-165：所有场景的新部门必填；DEC-163 允许其余不带出字段存空。 */
export function requiredTransferFields(form: TransferRequiredForm): readonly string[] {
  return form.fieldModes['preset:departmentId'] === 'editable' ? ['departmentId'] : [];
}

export function missingTransferRequiredFields(
  form: TransferRequiredForm,
  effectiveFields: Readonly<Record<string, unknown>>,
  options: { includeNonEditable?: boolean } = {},
): readonly string[] {
  return (options.includeNonEditable ? ['departmentId'] : requiredTransferFields(form)).filter((field) => {
    const value = effectiveFields[field];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
}

/** PR-A 记录实际落地为空的字段，供 PR-B 建立补全待办；派生值与非可编辑字段不误报。 */
export function clearedTransferFields(
  form: TransferRequiredForm,
  effectiveFields: Readonly<Record<string, unknown>>,
): readonly string[] {
  return (form.excludedAutofillFields ?? []).filter(
    (field) =>
      field !== 'departmentId' && form.fieldModes[`preset:${field}`] === 'editable' && effectiveFields[field] === null,
  );
}
