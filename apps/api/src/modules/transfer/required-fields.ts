import { missingTransferRequiredFields, type TransferRequiredForm } from '@italent/domain';
import { AppError } from '../../errors.js';

export function assertRequiredTransferFields(
  kind: string,
  form: TransferRequiredForm,
  effectiveFields: Readonly<Record<string, unknown>>,
): void {
  if (kind !== 'transfer') return;
  const missingFields = missingTransferRequiredFields(form, effectiveFields, { includeNonEditable: true });
  if (missingFields.length)
    throw new AppError('VALIDATION_FAILED', '请填写本场景必填的调动字段', {
      reason: 'TRANSFER_REQUIRED_FIELDS',
      missingFields,
    });
}
