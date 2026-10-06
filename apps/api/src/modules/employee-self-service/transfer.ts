import type { Tx } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { normalizeTransferInput, requireTransferWrite } from '../transfer/service.js';
import { previewTransfer } from '../transfer/preview.js';
import { readTransferCatalog } from '../transfer/configuration.js';
import { transferFieldAccess } from './access.js';

const inputSchema = z.strictObject({
  effectiveDate: z.string(),
  reasonCode: z.string().trim().min(1).max(100).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

/** 本人入口固定业务类型与提交动作，客户端不能借 mode/initiator/employeeId 提权。 */
export async function ownTransferInput(tx: Tx, ctx: EmploymentContext, raw: unknown) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '本人调动表单字段不合法');
  const input = await normalizeTransferInput(tx, ctx, {
    ...parsed.data,
    initiator: 'employee',
    transferTypeCode: 'in_department',
    formId: 'TenantBase.TransferMultiFormView',
    mode: 'application',
    submit: true,
  });
  await requireTransferWrite({ ...ctx, authorize: ctx.authorize && authorizeInTransaction(ctx.authorize, tx) }, input);
  return input;
}

export async function ownTransferPreview(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  raw: unknown,
  originalDeps: TenantRouteDeps,
) {
  const input = await ownTransferInput(tx, ctx, raw);
  const preview = await previewTransfer(tx, ctx, employeeId, input);
  const visible = await transferFieldAccess(tx, originalDeps, ctx);
  const authorize = authorizeInTransaction(ctx.authorize!, tx);
  const fieldModes: Record<string, 'editable' | 'readonly'> = {};
  for (const [code, mode] of Object.entries(preview.value.form.fieldModes)) {
    const field = code.replace(/^preset:/, '');
    if (!visible.has(field) || ['hidden', 'absent'].includes(mode)) continue;
    const editable =
      mode === 'editable' &&
      (await authorize({
        ...ctx,
        action: 'object.create',
        resource: EMPLOYMENT_OBJECT,
        fields: [field],
      }));
    fieldModes[code] = editable ? 'editable' : 'readonly';
  }
  const trim = (fields: object, prefix = 'preset') =>
    Object.fromEntries(Object.entries(fields).filter(([key]) => Object.hasOwn(fieldModes, `${prefix}:${key}`)));
  const catalog = await readTransferCatalog(tx, ctx.tenantId, input.employment.effectiveDate);
  return {
    ...preview.value,
    basicFieldModes: {
      effectiveDate: visible.has('effectiveDate') ? 'editable' : 'hidden',
      reasonCode: visible.has('reasonCode')
        ? (await authorize({ ...ctx, action: 'object.create', resource: EMPLOYMENT_OBJECT, fields: ['reasonCode'] }))
          ? 'editable'
          : 'readonly'
        : 'hidden',
    },
    fields: trim(preview.value.fields),
    customFields: trim(preview.value.customFields, 'custom'),
    before: preview.value.before
      ? {
          fields: trim(preview.value.before.fields),
          customFields: trim(preview.value.before.customFields, 'custom'),
        }
      : null,
    form: {
      ...preview.value.form,
      fieldModes,
      customFields: preview.value.form.customFields.filter((field) => visible.has(`custom:${field.id}`)),
      excludedAutofillFields: preview.value.form.excludedAutofillFields.filter((field) => visible.has(field)),
    },
    reasons: catalog.reasons.filter(
      (reason) =>
        visible.has('reasonCode') && (!reason.transferTypeCode || reason.transferTypeCode === 'in_department'),
    ),
    // DEC-191：兼职由 R2 提供适配器；此处只声明能力端口，不提供伪操作。
    partTimeAdjustment: { available: false },
  };
}
