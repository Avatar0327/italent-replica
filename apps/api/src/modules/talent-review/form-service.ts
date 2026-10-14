/**
 * 盘点内容表单的读写（设计 §2.2 forms / form_fields；DEC-306①）。表单是一个聚合：字段（三档 + required）随表单整组读写，
 * 修改时 fields 整组替换。在 config-kit.ts 的通用骨架之上加表单自己的规则：
 * - 字段在表单里至多一次、required 只配在 edit 上（领域层 checkFormFields）；
 * - 引用的字段须当前操作人在字段目录范围内可见（reference-kit.ts），新引用已停用的字段 400；
 * - 编码与名称租户唯一；预置表单不能删除（可停用）；表单被模板引用时拒删（B6 登记守卫），字段被表单引用时拒删。
 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewFields as F,
  talentReviewFormFields as FF,
  talentReviewForms as FM,
  type Tx,
} from '@italent/db';
import { checkFormFields } from '@italent/domain';
import { AppError } from '../../errors.js';
import { requireConfigCreatable } from './access.js';
import {
  auditConfig,
  type ConfigSpec,
  type ConfigTable,
  createConfig,
  deleteConfig,
  lockConfigRow,
  registerConfigReferenceGuard,
  requireSeeAllToRename,
  uniqueOr,
} from './config-kit.js';
import type { FormCreate, FormPatch } from './form-flow-input.js';
import { checkReferences, type ReferenceWriteContext, type ReferencedTable } from './reference-kit.js';

const row = {
  id: FM.id,
  code: FM.code,
  name: FM.name,
  kind: FM.kind,
  preset: FM.preset,
  sortNo: FM.sortNo,
  enabled: FM.enabled,
  revision: FM.revision,
  createdBy: FM.createdBy,
  createdAt: FM.createdAt,
  updatedBy: FM.updatedBy,
  updatedAt: FM.updatedAt,
};
type FormRow = Omit<typeof FM.$inferSelect, 'tenantId'>;
export interface FormFieldView {
  readonly fieldId: string;
  readonly access: string;
  readonly required: boolean;
}
export type FormView = FormRow & { fields: FormFieldView[] };

/** 列表与详情共用：一次查出这批表单的全部字段，按表单归位。 */
export async function withFields(tx: Tx, tenantId: string, rows: FormRow[]): Promise<FormView[]> {
  if (rows.length === 0) return [];
  const fields = await tx
    .select({ formId: FF.formId, fieldId: FF.fieldId, access: FF.access, required: FF.required })
    .from(FF)
    .where(
      and(
        eq(FF.tenantId, tenantId),
        inArray(
          FF.formId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(FF.sortNo), asc(FF.id));
  return rows.map((r) => ({
    ...r,
    fields: fields
      .filter((f) => f.formId === r.id)
      .map(({ fieldId, access, required }) => ({ fieldId, access, required })),
  }));
}

export const FORM: ConfigSpec<FormView> = {
  object: 'form',
  label: '盘点内容表单',
  table: FM as unknown as ConfigTable,
  view: row,
  orderBy: [
    ['sortNo', FM.sortNo],
    ['code', FM.code],
  ],
  duplicate: 'FORM_DUPLICATE',
  inUse: 'FORM_IN_USE',
  load: async (tx, tenantId, id) => {
    const rows = await tx
      .select(row)
      .from(FM)
      .where(and(eq(FM.tenantId, tenantId), eq(FM.id, id)));
    return (await withFields(tx, tenantId, rows))[0];
  },
};

const FIELD_REFERENCE = {
  table: F as unknown as ReferencedTable,
  object: 'field',
  disabledReason: 'FORM_FIELD_DISABLED',
  label: '盘点字段',
} as const;

/** 重放的字段引用复核由路由层（requireReferencesVisible）按字段目录范围做，这里是写入路径。 */
const requireReferences = (tx: Tx, ctx: ReferenceWriteContext, held: ReadonlySet<string>) =>
  checkReferences(tx, ctx, FIELD_REFERENCE, ctx.references ?? [], held);

function checkFields(fields: FormCreate['fields']) {
  const problem = checkFormFields(fields);
  if (problem) throw new AppError('VALIDATION_FAILED', problem.message, { reason: problem.reason });
}
const fieldRows = (tenantId: string, formId: string, fields: FormCreate['fields']) =>
  fields.map((field, index) => ({ tenantId, formId, ...field, sortNo: index + 1 }));

export async function createForm(tx: Tx, ctx: ReferenceWriteContext, input: FormCreate): Promise<FormView> {
  const { fields, ...columns } = input;
  // 新建范围先于一切读取：范围为空的人对任何字段引用都得到同一个结果
  requireConfigCreatable(ctx.scope, 'form');
  checkFields(fields);
  await requireReferences(tx, ctx, new Set());
  return createConfig(tx, FORM, ctx, columns, async (id) => {
    if (fields.length > 0) await tx.insert(FF).values(fieldRows(ctx.tenantId, id, fields));
  });
}

export async function updateForm(tx: Tx, ctx: ReferenceWriteContext, id: string, patch: FormPatch): Promise<FormView> {
  await lockConfigRow(tx, FORM, ctx, id);
  const before = (await FORM.load!(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const { fields, ...columns } = patch;
  if (fields !== undefined) checkFields(fields);
  await requireReferences(tx, ctx, new Set(before.fields.map((f) => f.fieldId)));
  await uniqueOr(FORM.duplicate, FORM.label, () =>
    tx
      .update(FM)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(FM.tenantId, ctx.tenantId), eq(FM.id, id))),
  );
  if (fields !== undefined) {
    await tx.delete(FF).where(and(eq(FF.tenantId, ctx.tenantId), eq(FF.formId, id)));
    if (fields.length > 0) await tx.insert(FF).values(fieldRows(ctx.tenantId, id, fields));
  }
  const after = (await FORM.load!(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'form', 'update', id, before, after);
  return after;
}

export function deleteForm(tx: Tx, ctx: ReferenceWriteContext, id: string): Promise<FormView> {
  return deleteConfig(tx, FORM, ctx, id, (before) => {
    if (before.preset) throw new AppError('CONFLICT', '预置表单不能删除，可以停用', { reason: 'FORM_PRESET' });
  });
}

// 字段被表单引用时拒删（外键 restrict 兜底；这里给出可读的 409 FIELD_IN_USE 而不是 500）
registerConfigReferenceGuard('field', async (tx, tenantId, id) => {
  const [found] = await tx
    .select({ id: FF.id })
    .from(FF)
    .where(and(eq(FF.tenantId, tenantId), eq(FF.fieldId, id)))
    .limit(1);
  return found ? 'FORM_FIELD' : null;
});
