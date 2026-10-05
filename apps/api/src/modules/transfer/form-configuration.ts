import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { TRANSFER_FORMS, type TransferFieldMode, type TransferFormDefinition } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { getCustomFieldsForInheritance, type CustomFieldDefinition } from '../employment/configuration.js';
import { assertRevision, auditEmployment } from '../employment/context.js';
import { rowsOf } from '../employment/read-model.js';
import { PRESET_FIELD_NAMES, type EmploymentContext } from '../employment/types.js';
import { readTransferSettings } from './configuration.js';

export interface ResolvedTransferForm extends TransferFormDefinition {
  readonly revision: number;
  readonly grouped: boolean;
  readonly customMode: TransferFieldMode;
  readonly fieldModes: Readonly<Record<string, TransferFieldMode>>;
  readonly customFields: readonly CustomFieldDefinition[];
  readonly autoPopulate: boolean;
}
const modes = z.enum(['editable', 'readonly', 'hidden', 'absent']);
const formInput = z.strictObject({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  group: z.literal('transfer').nullable(),
  processCode: z
    .string()
    .regex(/^(TransferProcessNew|Customized[1-7]TransferFlow)$/)
    .optional(),
  fieldModes: z.record(z.string().max(100), modes).refine((fields) => Object.keys(fields).length <= 250),
});
export type TransferFormInput = z.input<typeof formInput>;
interface StoredForm {
  readonly objectId: string;
  readonly id: string;
  readonly revision: number;
  readonly versionId: string;
  readonly name: string;
  readonly group: 'transfer' | null;
  readonly processCode: string;
}
const selectForm = sql`
  SELECT f.id AS "objectId",f.form_id AS id,f.revision,v.id AS "versionId",v.name,v."group",
    v.process_code AS "processCode"
  FROM transfer_forms f JOIN transfer_form_versions v
    ON v.tenant_id=f.tenant_id AND v.form_id=f.id AND v.version_no=f.revision
`;
// standard 是历史任职写入接口的通用表单；真实调动入口须选注册表中的具体场景。

export async function resolveTransferForm(tx: Tx, tenantId: string, id: string): Promise<ResolvedTransferForm> {
  const standard = TRANSFER_FORMS.find((form) => form.id === id);
  const [stored] = rowsOf<StoredForm>(
    await tx.execute(sql`${selectForm}
    WHERE f.tenant_id=${tenantId} AND f.form_id=${id} LIMIT 1
  `),
  );
  const legacy = id === 'standard';
  if (!standard && !stored && !legacy) throw new AppError('VALIDATION_FAILED', '调动表单未配置');
  const definitions = await getCustomFieldsForInheritance(tx, tenantId);
  const fieldModes: Record<string, TransferFieldMode> = Object.fromEntries([
    ...PRESET_FIELD_NAMES.map((name) => [`preset:${name}`, 'editable' as const]),
    ...definitions.map((field) => [`custom:${field.id}`, 'editable' as const]),
  ]);
  // 12 附录：本人调动表单仅任职调整基本字段，无薪资、合同、试岗、编制区块。
  if (id.startsWith('TenantBase.Personal')) {
    const personal = new Set(['departmentId', 'directManagerId', 'postId', 'levelId', 'sequenceId']);
    for (const field of PRESET_FIELD_NAMES) fieldModes[`preset:${field}`] = personal.has(field) ? 'editable' : 'absent';
    for (const field of definitions) fieldModes[`custom:${field.id}`] = 'absent';
  }
  if (stored) {
    const fields = rowsOf<{ code: string; mode: TransferFieldMode }>(
      await tx.execute(sql`
      SELECT field_code AS code,mode FROM transfer_form_fields
      WHERE tenant_id=${tenantId} AND version_id=${stored.versionId} ORDER BY field_code LIMIT 251
    `),
    );
    if (fields.length > 250) throw new AppError('SERVICE_UNAVAILABLE', '表单字段超出当前处理预算');
    for (const field of fields) fieldModes[field.code] = field.mode;
  }
  return {
    id,
    name: stored?.name ?? standard?.name ?? id,
    isStandard: standard !== undefined,
    revision: stored?.revision ?? 0,
    processCode: standard?.processCode ?? stored?.processCode ?? 'TransferProcessNew',
    excludedAutofillFields: standard?.excludedAutofillFields ?? [],
    grouped: stored ? stored.group === 'transfer' : true,
    customMode: 'editable',
    fieldModes,
    customFields: definitions,
    autoPopulate: (await readTransferSettings(tx, tenantId)).autoPopulate,
  };
}

export async function listTransferForms(tx: Tx, tenantId: string): Promise<TransferFormDefinition[]> {
  const stored = rowsOf<StoredForm>(
    await tx.execute(sql`${selectForm}
    WHERE f.tenant_id=${tenantId} ORDER BY f.form_id LIMIT 101
  `),
  );
  if (stored.length > 100) throw new AppError('SERVICE_UNAVAILABLE', '调动表单超出当前处理预算');
  const forms = new Map(TRANSFER_FORMS.map((form) => [form.id, form]));
  for (const form of stored) {
    const standard = forms.get(form.id);
    forms.set(form.id, {
      id: form.id,
      name: form.name,
      isStandard: standard !== undefined,
      processCode: standard?.processCode ?? form.processCode,
      excludedAutofillFields: standard?.excludedAutofillFields ?? [],
    });
  }
  return [...forms.values()];
}

export async function saveTransferForm(tx: Tx, ctx: EmploymentContext, input: unknown) {
  const parsed = formInput.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '调动表单配置不合法');
  const value = parsed.data;
  if (value.id === 'standard') throw new AppError('VALIDATION_FAILED', '旧表单标识不能覆盖');
  const standard = TRANSFER_FORMS.find((form) => form.id === value.id);
  const processCode = value.processCode ?? standard?.processCode ?? 'TransferProcessNew';
  if (standard && (standard.processCode !== processCode || value.group !== 'transfer'))
    throw new AppError('VALIDATION_FAILED', '标准表单的流程绑定与分组不可改');
  const definitions = await getCustomFieldsForInheritance(tx, ctx.tenantId);
  const allowed = new Set([
    ...PRESET_FIELD_NAMES.map((field) => `preset:${field}`),
    ...definitions.map((field) => `custom:${field.id}`),
  ]);
  if (Object.keys(value.fieldModes).some((code) => !allowed.has(code)))
    throw new AppError('VALIDATION_FAILED', '表单字段不属于本租户任职对象');
  // 同租户创建也串行，避免两个新表单同时越过数量上限。
  await tx.execute(sql`INSERT INTO transfer_settings(tenant_id) VALUES(${ctx.tenantId}) ON CONFLICT DO NOTHING`);
  await tx.execute(sql`SELECT revision FROM transfer_settings WHERE tenant_id=${ctx.tenantId} FOR UPDATE`);
  const [existing] = rowsOf<{ id: string; revision: number }>(
    await tx.execute(sql`
    SELECT id,revision FROM transfer_forms WHERE tenant_id=${ctx.tenantId} AND form_id=${value.id} FOR UPDATE
  `),
  );
  assertRevision(ctx.expectedRevision, existing?.revision ?? 0);
  if (!existing) {
    const [count] = rowsOf<{ count: number }>(
      await tx.execute(sql`
      SELECT count(*)::integer AS count FROM transfer_forms WHERE tenant_id=${ctx.tenantId}
    `),
    );
    if (count!.count >= 100) throw new AppError('SERVICE_UNAVAILABLE', '调动表单超出当前处理预算');
  }
  const before = existing ? await resolveTransferForm(tx, ctx.tenantId, value.id) : null;
  const objectId = existing?.id ?? randomUUID();
  if (!existing)
    await tx.execute(sql`
    INSERT INTO transfer_forms(id,tenant_id,form_id) VALUES(${objectId},${ctx.tenantId},${value.id})
  `);
  const versionId = randomUUID();
  const revision = (existing?.revision ?? 0) + 1;
  await tx.execute(sql`
    INSERT INTO transfer_form_versions(id,tenant_id,form_id,version_no,name,"group",process_code,created_at)
    VALUES(${versionId},${ctx.tenantId},${objectId},${revision},${value.name},${value.group},
      ${processCode},${ctx.now.toISOString()})
  `);
  for (const [code, mode] of Object.entries(value.fieldModes))
    await tx.execute(sql`
    INSERT INTO transfer_form_fields(tenant_id,version_id,field_code,mode)
    VALUES(${ctx.tenantId},${versionId},${code},${mode})
  `);
  await tx.execute(
    sql`UPDATE transfer_forms SET revision=${revision} WHERE tenant_id=${ctx.tenantId} AND id=${objectId}`,
  );
  const after = await resolveTransferForm(tx, ctx.tenantId, value.id);
  await auditEmployment(tx, ctx, 'transfer.form.save', 'transfer_form', objectId, before, after);
  return after;
}
