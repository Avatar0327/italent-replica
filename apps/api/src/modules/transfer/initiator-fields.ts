import type { Tx } from '@italent/db';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction, editableModuleFields } from '../permission/module-access.js';
import type { ResolvedTransferForm } from './form-configuration.js';

/** DEC-205：不可编辑字段按只读继承，不因完整表单的场景留空而清掉隐藏字段。显式写入仍由授权器拒绝。 */
export async function applyInitiatorFieldModes(tx: Tx, ctx: EmploymentContext, form: ResolvedTransferForm) {
  if (!ctx.managerTransfer || !ctx.authorize) return form;
  const authorize = authorizeInTransaction(ctx.authorize, tx);
  const editable = await editableModuleFields(ctx.authorize, tx, ctx, 'TenantBase.EmploymentRecord');
  const fieldModes: Record<string, 'editable' | 'readonly' | 'hidden' | 'absent'> = {};
  for (const [code, mode] of Object.entries(form.fieldModes)) {
    fieldModes[code] =
      mode === 'editable' &&
      !(editable
        ? editable.has(code.replace(/^preset:/, ''))
        : await authorize({
            ...ctx,
            action: 'object.create',
            resource: 'TenantBase.EmploymentRecord',
            fields: [code.replace(/^preset:/, '')],
          }))
        ? 'readonly'
        : mode;
  }
  return { ...form, fieldModes };
}
