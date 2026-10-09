/**
 * 盘点字段目录的读写（设计 §2.2 fields / field_options、§2.7）。在 config-kit.ts 的通用骨架之上加字段自己的规则：
 * - number 才有小数位（缺省 2），option / multi_option 才有选项且至少一项，value 唯一；编码、类型建后不可改；
 * - 选项按稳定 value 比较（DEC-257）：修改时已有 value 必须全部保留（只能新增、改标签 / 排序、停用），否则 400；
 * - 校准前 / 后成对：类型相同、角色相反、一对一，同一事务双向写入；成对字段与预置字段不可删（可停用）。
 */
import { and, asc, eq, inArray, talentReviewFieldOptions as O, talentReviewFields as F, type Tx } from '@italent/db';
import { FIELD_DEFAULT_PRECISION } from '@italent/domain';
import { AppError } from '../../errors.js';
import {
  auditConfig,
  type ConfigSpec,
  type ConfigTable,
  createConfig,
  deleteConfig,
  listConfig,
  lockConfigRow,
  requireSeeAllToRename,
  uniqueOr,
  type WriteContext,
} from './config-kit.js';
import type { FieldCreate, FieldOptionInput, FieldPatch } from './config-input.js';

const row = {
  id: F.id,
  code: F.code,
  name: F.name,
  kind: F.kind,
  group: F.group,
  preset: F.preset,
  systemWritten: F.systemWritten,
  pairRole: F.pairRole,
  pairFieldId: F.pairFieldId,
  precision: F.precision,
  sortNo: F.sortNo,
  enabled: F.enabled,
  revision: F.revision,
  createdBy: F.createdBy,
  createdAt: F.createdAt,
  updatedBy: F.updatedBy,
  updatedAt: F.updatedAt,
};
export interface FieldOptionView {
  readonly value: string;
  readonly label: string;
  readonly sortNo: number;
  readonly enabled: boolean;
}
export type FieldView = Omit<typeof F.$inferSelect, 'tenantId'> & { options: FieldOptionView[] };

export const FIELD: ConfigSpec<FieldView> = {
  object: 'field',
  label: '盘点字段',
  table: F as unknown as ConfigTable,
  view: row,
  orderBy: [F.sortNo, F.code],
  duplicate: 'FIELD_DUPLICATE',
  inUse: 'FIELD_IN_USE',
  load: async (tx, tenantId, id) => (await withOptions(tx, tenantId, await selectRows(tx, tenantId, [id])))[0],
};

const selectRows = (tx: Tx, tenantId: string, ids: string[]) =>
  tx
    .select(row)
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, ids)));

export async function withOptions(tx: Tx, tenantId: string, rows: Omit<FieldView, 'options'>[]): Promise<FieldView[]> {
  if (rows.length === 0) return [];
  const options = await tx
    .select({
      fieldId: O.fieldId,
      value: O.value,
      label: O.label,
      sortNo: O.sortNo,
      enabled: O.enabled,
    })
    .from(O)
    .where(
      and(
        eq(O.tenantId, tenantId),
        inArray(
          O.fieldId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(O.sortNo), asc(O.value));
  return rows.map((r) => ({
    ...r,
    options: options.filter((o) => o.fieldId === r.id).map(({ fieldId: _fieldId, ...rest }) => rest),
  }));
}

export async function listFieldViews(tx: Tx, tenantId: string, query: Parameters<typeof listConfig>[3]) {
  const rows = (await listConfig(tx, FIELD, tenantId, query)) as Omit<FieldView, 'options'>[];
  return withOptions(tx, tenantId, rows);
}
export const loadFieldView = (tx: Tx, tenantId: string, id: string) => FIELD.load!(tx, tenantId, id);

const invalid = (reason: string, message: string, extra: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra });
const hasOptions = (kind: string) => kind === 'option' || kind === 'multi_option';

function checkOptions(kind: string, options: readonly FieldOptionInput[] | undefined, required: boolean) {
  if (options === undefined) {
    if (required && hasOptions(kind)) throw invalid('FIELD_OPTIONS_REQUIRED', '单选 / 多选字段必须至少有一个选项');
    return;
  }
  if (!hasOptions(kind)) throw invalid('FIELD_OPTIONS_NOT_ALLOWED', '只有单选 / 多选字段可以配置选项');
  if (required && options.length === 0) throw invalid('FIELD_OPTIONS_REQUIRED', '单选 / 多选字段必须至少有一个选项');
  if (new Set(options.map((o) => o.value)).size !== options.length) {
    throw invalid('FIELD_OPTION_DUPLICATE', '选项值重复');
  }
}

async function insertOptions(tx: Tx, ctx: WriteContext, fieldId: string, options: readonly FieldOptionInput[]) {
  if (options.length === 0) return;
  await tx.insert(O).values(
    options.map((o, index) => ({
      tenantId: ctx.tenantId,
      fieldId,
      value: o.value,
      label: o.label,
      sortNo: o.sortNo ?? index + 1,
      enabled: o.enabled ?? true,
    })),
  );
}

/** 成对字段：锁住另一端，校验类型相同 / 角色相反 / 尚未成对（先于新建，否则会先撞一对一唯一约束）。 */
async function lockPartner(tx: Tx, ctx: WriteContext, input: FieldCreate): Promise<string> {
  const [partner] = await tx
    .select({ id: F.id, kind: F.kind, pairRole: F.pairRole, pairFieldId: F.pairFieldId })
    .from(F)
    .where(and(eq(F.tenantId, ctx.tenantId), eq(F.id, input.pairFieldId!)))
    .for('update');
  if (!partner || partner.kind !== input.kind || partner.pairRole === null || partner.pairRole === input.pairRole) {
    throw invalid('PAIR_INVALID', '成对字段必须是另一个角色相反、类型相同的字段');
  }
  if (partner.pairFieldId !== null) {
    throw new AppError('CONFLICT', '该字段已有成对字段', { reason: 'PAIR_ALREADY_USED' });
  }
  return partner.id;
}

/** 双向写入：另一端同事务回填 pair_field_id，留 revision 与审计。 */
async function linkPartner(tx: Tx, ctx: WriteContext, id: string, partnerId: string) {
  const before = (await loadFieldView(tx, ctx.tenantId, partnerId))!;
  await tx
    .update(F)
    .set({ pairFieldId: id, revision: before.revision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
    .where(and(eq(F.tenantId, ctx.tenantId), eq(F.id, partnerId)));
  await auditConfig(tx, ctx, 'field', 'update', partnerId, before, await loadFieldView(tx, ctx.tenantId, partnerId));
}

export async function createField(tx: Tx, ctx: WriteContext, input: FieldCreate): Promise<FieldView> {
  const { options, precision, ...columns } = input;
  if (input.pairFieldId !== undefined && input.pairRole === undefined) {
    throw invalid('PAIR_ROLE_REQUIRED', '指定成对字段时必须给出本字段的角色');
  }
  if (input.kind !== 'number' && precision !== undefined) {
    throw invalid('FIELD_PRECISION_NOT_ALLOWED', '只有数值字段可以设置小数位');
  }
  checkOptions(input.kind, options, true);
  const partnerId = input.pairFieldId === undefined ? undefined : await lockPartner(tx, ctx, input);
  const created = await createConfig(tx, FIELD, ctx, {
    ...columns,
    precision: input.kind === 'number' ? (precision ?? FIELD_DEFAULT_PRECISION) : null,
  });
  await insertOptions(tx, ctx, created.id, options ?? []);
  if (partnerId) await linkPartner(tx, ctx, created.id, partnerId);
  return (await loadFieldView(tx, ctx.tenantId, created.id))!;
}

async function syncOptions(tx: Tx, ctx: WriteContext, fieldId: string, options: readonly FieldOptionInput[]) {
  const existing = await tx
    .select({ value: O.value, label: O.label, sortNo: O.sortNo, enabled: O.enabled })
    .from(O)
    .where(and(eq(O.tenantId, ctx.tenantId), eq(O.fieldId, fieldId)));
  const byValue = new Map(existing.map((o) => [o.value, o]));
  const given = new Set(options.map((o) => o.value));
  if (existing.some((o) => !given.has(o.value))) {
    throw invalid('FIELD_OPTION_REMOVED', '已有选项不能删除，请停用');
  }
  const fresh = options
    .map((o, index) => ({ ...o, sortNo: o.sortNo ?? index + 1 }))
    .filter((o) => !byValue.has(o.value));
  await insertOptions(tx, ctx, fieldId, fresh);
  for (const [index, option] of options.entries()) {
    const current = byValue.get(option.value);
    if (!current) continue;
    await tx
      .update(O)
      .set({
        label: option.label,
        sortNo: option.sortNo ?? current.sortNo ?? index + 1,
        enabled: option.enabled ?? current.enabled,
      })
      .where(and(eq(O.tenantId, ctx.tenantId), eq(O.fieldId, fieldId), eq(O.value, option.value)));
  }
}

export async function updateField(tx: Tx, ctx: WriteContext, id: string, patch: FieldPatch): Promise<FieldView> {
  await lockConfigRow(tx, FIELD, ctx, id);
  const before = (await loadFieldView(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  if (patch.precision !== undefined && before.kind !== 'number') {
    throw invalid('FIELD_PRECISION_NOT_ALLOWED', '只有数值字段可以设置小数位');
  }
  checkOptions(before.kind, patch.options, false);
  const { options, ...columns } = patch;
  await uniqueOr(FIELD.duplicate, FIELD.label, () =>
    tx
      .update(F)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(F.tenantId, ctx.tenantId), eq(F.id, id))),
  );
  if (options !== undefined) await syncOptions(tx, ctx, id, options);
  const after = (await loadFieldView(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'field', 'update', id, before, after);
  return after;
}

export function deleteField(tx: Tx, ctx: WriteContext, id: string): Promise<FieldView> {
  return deleteConfig(tx, FIELD, ctx, id, (before) => {
    if (before.preset) throw new AppError('CONFLICT', '预置字段不能删除，可以停用', { reason: 'FIELD_PRESET' });
    if (before.pairFieldId !== null) {
      throw new AppError('CONFLICT', '成对字段不能单独删除，可以停用', { reason: 'FIELD_PAIRED' });
    }
  });
}
