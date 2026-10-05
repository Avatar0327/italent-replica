import type { Tx } from '@italent/db';
import { readEmploymentSettings, getCustomFieldsForInheritance } from '../employment/configuration.js';
import { prepareInheritance, inheritancePreview } from '../employment/inheritance.js';
import { findPredecessor } from '../employment/read-model.js';
import { readEmploymentEmployee } from '../employment/record-store.js';
import { requireScopedEmploymentObject } from '../employment/context.js';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { resolveTransferForm } from './configuration.js';
import { transferDirectActions, requireTransferSource } from './access.js';
import { transferTargetContext, type TransferInput } from './service.js';

export async function previewTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string, input: TransferInput) {
  const accessContext = { ...ctx, authorize: ctx.authorize ? authorizeInTransaction(ctx.authorize, tx) : undefined };
  await requireTransferSource(tx, ctx, employeeId, input.initiator);
  const employee = await readEmploymentEmployee(tx, ctx, employeeId);
  const prepared = await prepareInheritance(tx, ctx, { ...input.employment, employeeId });
  const context = await transferTargetContext(tx, ctx, employeeId, input, prepared.fields.departmentId);
  // 未选部门的场景表单允许预览；有目标时与保存使用同一范围判定。
  if (prepared.fields.departmentId)
    await requireScopedEmploymentObject(tx, context, employeeId, prepared.fields.departmentId);
  const before = await findPredecessor(tx, ctx.tenantId, employeeId, input.employment.effectiveDate);
  const form = await resolveTransferForm(tx, ctx.tenantId, input.employment.formId);
  const settings = await readEmploymentSettings(tx, ctx.tenantId);
  const visible = (prefix: string, fields: object) =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([field]) => !['hidden', 'absent'].includes(form.fieldModes[`${prefix}:${field}`] ?? 'editable'),
      ),
    );
  return {
    context,
    value: {
      employeeId,
      form: { ...form, customFields: await getCustomFieldsForInheritance(tx, ctx.tenantId) },
      ...inheritancePreview(prepared),
      before: before
        ? { fields: visible('preset', before.fields), customFields: visible('custom', before.customFields) }
        : null,
      employeeRevision: employee.revision,
      allowDirectTransfer: settings.allowDirectTransfer,
      allowedActions: {
        application: true,
        ...(await transferDirectActions(accessContext, settings.allowDirectTransfer)),
      },
    },
  };
}
