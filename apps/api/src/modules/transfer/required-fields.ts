import { missingTransferRequiredFields, requiredTransferFields, type TransferRequiredForm } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { PreparedInheritance } from '../employment/inheritance.js';
import type { EmploymentBusinessPatch } from '../employment/types.js';

export function assertRequiredTransferFields(
  kind: string,
  form: TransferRequiredForm,
  submittedFields: Readonly<Record<string, unknown>>,
): void {
  if (kind !== 'transfer') return;
  const missingFields = missingTransferRequiredFields(form, submittedFields);
  if (missingFields.length)
    throw new AppError('VALIDATION_FAILED', '请填写本场景必填的调动字段', {
      reason: 'TRANSFER_REQUIRED_FIELDS',
      missingFields,
    });
}

/** 旧真实表单没有提交来源证据时，可能由服务端派生的必填字段须先由用户确认；legacy standard 不受影响。 */
function submittedCodes(payload: PreparedInheritance): readonly string[] {
  if (payload.formSnapshot.submittedFieldCodes) return payload.formSnapshot.submittedFieldCodes;
  const required = new Set(requiredTransferFields(payload.formSnapshot));
  return payload.explicitFieldCodes.filter(
    (code) =>
      !(['preset:directManagerId', 'preset:sequenceId'].includes(code) && required.has(code.slice('preset:'.length))),
  );
}

export function submittedEmploymentFields(payload: PreparedInheritance): Readonly<Record<string, unknown>> {
  const submitted = new Set(submittedCodes(payload));
  return Object.fromEntries(Object.entries(payload.fields).filter(([field]) => submitted.has(`preset:${field}`)));
}

export function patchedSubmittedFieldCodes(payload: PreparedInheritance, patch: EmploymentBusinessPatch) {
  // 与 normalizePatchedInput 的 DEC-107 同步：改选职务时旧序列会被丢弃，新派生值不继承旧填写来源。
  const resetSequence =
    patch.fields && Object.hasOwn(patch.fields, 'postId') && !Object.hasOwn(patch.fields, 'sequenceId');
  return [
    ...new Set([
      ...submittedCodes(payload).filter((code) => !(resetSequence && code === 'preset:sequenceId')),
      ...Object.keys(patch.fields ?? {}).map((field) => `preset:${field}`),
      ...Object.keys(patch.customFields ?? {}).map((field) => `custom:${field}`),
    ]),
  ];
}
