import type { TransferFieldMode } from './catalog.js';

export interface TransferRequiredForm {
  readonly excludedAutofillFields?: readonly string[];
  readonly fieldModes: Readonly<Record<string, TransferFieldMode>>;
}

/** DEC-163 / Q-M0-65：新部门必填；其它场景不带出的可编辑字段允许存空，不沿用前一条。 */
export function requiredTransferFields(form: TransferRequiredForm): readonly string[] {
  return (form.excludedAutofillFields ?? []).filter(
    (field) => field === 'departmentId' && form.fieldModes[`preset:${field}`] === 'editable',
  );
}

export function missingTransferRequiredFields(
  form: TransferRequiredForm,
  effectiveFields: Readonly<Record<string, unknown>>,
): readonly string[] {
  return requiredTransferFields(form).filter((field) => {
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
