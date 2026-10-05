import { sql, type Tx } from '@italent/db';
import {
  TRANSFER_FORMS,
  TRANSFER_REASONS,
  TRANSFER_TYPES,
  sortTransferDictionary,
  type TransferReasonDefinition,
  type TransferTypeDefinition,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { assertRevision, auditEmployment } from '../employment/context.js';
import { businessDate } from '../employment/fields.js';
import { rowsOf } from '../employment/read-model.js';
import type { EmploymentContext } from '../employment/types.js';
import { listTransferForms } from './form-configuration.js';
export { listTransferForms, resolveTransferForm, saveTransferForm } from './form-configuration.js';
export type { ResolvedTransferForm, TransferFormInput } from './form-configuration.js';

export interface TransferSettings {
  readonly revision: number;
  readonly unrestrictTargetDepartment: boolean;
  readonly autoPopulate: boolean;
}
const settingInput = z.strictObject({ unrestrictTargetDepartment: z.boolean(), autoPopulate: z.boolean() });
export async function readTransferSettings(tx: Tx, tenantId: string): Promise<TransferSettings> {
  const [row] = rowsOf<TransferSettings>(
    await tx.execute(sql`
    SELECT s.revision,COALESCE(v.unrestrict_target_department,true) AS "unrestrictTargetDepartment",
      COALESCE(v.auto_populate,true) AS "autoPopulate"
    FROM transfer_settings s LEFT JOIN transfer_setting_versions v
      ON v.tenant_id=s.tenant_id AND v.version_no=s.revision WHERE s.tenant_id=${tenantId}
  `),
  );
  return row ?? { revision: 0, unrestrictTargetDepartment: true, autoPopulate: true };
}
export async function updateTransferSettings(tx: Tx, ctx: EmploymentContext, input: unknown) {
  const parsed = settingInput.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '调动开关必须为布尔值');
  await tx.execute(sql`INSERT INTO transfer_settings(tenant_id) VALUES(${ctx.tenantId}) ON CONFLICT DO NOTHING`);
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`
    SELECT revision FROM transfer_settings WHERE tenant_id=${ctx.tenantId} FOR UPDATE
  `),
  );
  assertRevision(ctx.expectedRevision, head!.revision);
  const before = await readTransferSettings(tx, ctx.tenantId);
  const after = { revision: before.revision + 1, ...parsed.data };
  await tx.execute(sql`
    INSERT INTO transfer_setting_versions(tenant_id,version_no,unrestrict_target_department,auto_populate,created_at)
    VALUES(${ctx.tenantId},${after.revision},${after.unrestrictTargetDepartment},${after.autoPopulate},
      ${ctx.now.toISOString()})
  `);
  await tx.execute(sql`UPDATE transfer_settings SET revision=${after.revision} WHERE tenant_id=${ctx.tenantId}`);
  await auditEmployment(tx, ctx, 'transfer.settings.update', 'transfer_settings', ctx.tenantId, before, after);
  return after;
}
function mergeDictionary<
  T extends { code: string; enabled: boolean; effectiveDate: string; displayOrder: number | null },
>(defaults: readonly T[], overrides: T[], effectiveDate: string): T[] {
  const entries = new Map(defaults.map((entry) => [entry.code, entry]));
  for (const entry of overrides) entries.set(entry.code, entry);
  return sortTransferDictionary(
    [...entries.values()].filter((entry) => entry.enabled && entry.effectiveDate <= effectiveDate),
  );
}
export async function readTransferCatalog(tx: Tx, tenantId: string, effectiveDate: string) {
  businessDate(effectiveDate);
  const types = rowsOf<TransferTypeDefinition>(
    await tx.execute(sql`
    SELECT code,name,effective_date AS "effectiveDate",enabled,display_order AS "displayOrder",form_id AS "formId"
    FROM transfer_types WHERE tenant_id=${tenantId} ORDER BY code LIMIT 501
  `),
  );
  const reasons = rowsOf<TransferReasonDefinition>(
    await tx.execute(sql`
    SELECT code,name,effective_date AS "effectiveDate",enabled,display_order AS "displayOrder",
      transfer_type_code AS "transferTypeCode"
    FROM transfer_reasons WHERE tenant_id=${tenantId} ORDER BY code LIMIT 501
  `),
  );
  if (types.length > 500 || reasons.length > 500) throw new AppError('SERVICE_UNAVAILABLE', '调动字典超出当前处理预算');
  return {
    types: mergeDictionary(TRANSFER_TYPES, types, effectiveDate),
    reasons: mergeDictionary(TRANSFER_REASONS, reasons, effectiveDate),
    forms: await listTransferForms(tx, tenantId),
  };
}

export function standardTransferForm(id: string) {
  return TRANSFER_FORMS.find((form) => form.id === id);
}
