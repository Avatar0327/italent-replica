/**
 * Offer 命令与查询（R2 BE-14a；34 §2.1、OF-R1 / R3 / R7 / R12，DEC-527③ / 529 / 532 / 533 / 537）。
 * 状态与表单规则全在领域纯函数（@italent/domain offer/rules.ts），这里负责加锁、范围、字典校验、落库与审计。
 * 要联动待入职的分支由纯函数返回 OFFER_SYNC_NOT_READY（409），本段不写待入职（BE-14b 接线）。
 */
import { and, desc, eq, offers, pgErrorCode, sql, type Tx } from '@italent/db';
import {
  effectiveOfferType,
  missingOfferFields,
  OFFER_FIELDS,
  OFFER_REFUSAL_FIELDS,
  OFFER_SEND_APPROVAL_DEFAULT,
  OFFER_SEND_APPROVAL_KEY,
  OFFER_TRANSITIONS,
  offerEditable,
  offerRowActions,
  planOfferInvalidation,
  planOfferSend,
  planOfferTransition,
  validOfferSendApprovalSetting,
  type OfferField,
  type OfferPlan,
  type OfferApprovalStatus,
  type OfferRowAction,
  type OfferStateFacts,
  type OfferStatus,
  type OfferType,
  type OfferView,
} from '@italent/domain';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { scopeSql } from '../permission/module-access.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertOfferDictionaryEnabled } from './dictionaries.js';
import { assertOfferRevision, requireOfferInScope, type OfferContext } from './context.js';
import type { OfferCreateInput, OfferInvalidateInput, OfferTransferInput, OfferUpdateInput } from './input.js';

export type OfferRow = typeof offers.$inferSelect;
const MONEY: readonly OfferField[] = [
  'salaryBeforeRegular',
  'salaryAfterRegular',
  'socialInsuranceBase',
  'housingFundBase',
];
/** 校招生提前实习从所选校招 Offer 带出的基本信息（未填时）。 */
const CAMPUS_CARRIED: readonly OfferField[] = [
  'name',
  'personalEmail',
  'mobile',
  'gender',
  'idType',
  'idNumber',
  'birthDate',
];

const typeOf = (row: Pick<OfferRow, 'offerType'>) => row.offerType as OfferType | null;
const facts = (row: OfferRow): OfferStateFacts => ({
  status: row.status as OfferStatus,
  approvalStatus: row.approvalStatus as OfferApprovalStatus,
  offerType: typeOf(row),
  hasPendingEntry: row.pendingEntryBusinessId !== null,
});

/** 接口形状：金额转数字；拒绝时间 / 原因 / 备注只在“已拒绝”时出现（DEC-532①：退回待发后保留但详情不显示）。 */
export function offerDto(row: OfferRow) {
  const { tenantId: _tenant, pendingEntryBusinessId, ...rest } = row;
  const dto: Record<string, unknown> = { ...rest, hasPendingEntry: pendingEntryBusinessId !== null };
  for (const field of MONEY) {
    const value = row[field as keyof OfferRow];
    dto[field] = value === null ? null : Number(value);
  }
  if (row.status !== 'rejected') for (const field of OFFER_REFUSAL_FIELDS) delete dto[field];
  return dto;
}

const withActions = (row: OfferRow, allowed: (action: OfferRowAction) => boolean) => {
  const actions = offerRowActions(facts(row));
  return {
    ...offerDto(row),
    rowActions: { primary: actions.primary.filter(allowed), menu: actions.menu.filter(allowed) },
  };
};

function failPlan(plan: Extract<OfferPlan<unknown>, { ok: false }>): never {
  const code = plan.reason === 'OFFER_FORM_INCOMPLETE' ? 'VALIDATION_FAILED' : 'CONFLICT';
  const message: Record<string, string> = {
    OFFER_TRANSITION_INVALID: '当前状态不能转移到目标状态',
    OFFER_APPROVAL_IN_PROGRESS: 'Offer 审批中，不能执行该操作',
    OFFER_SYNC_NOT_READY: '该操作需要联动待入职，暂未开放',
    OFFER_FORM_INCOMPLETE: '必填项未填写',
    OFFER_INVALIDATION_NOT_ALLOWED: '当前 Offer 不能失效',
    OFFER_APPROVAL_REQUIRED: '发送前须审批通过',
    OFFER_NOT_PENDING: '只有待发 Offer 可以发送',
  };
  throw new AppError(code, message[plan.reason]!, {
    reason: plan.reason,
    ...(plan.fields ? { fields: plan.fields } : {}),
  });
}

/** 审计归属录用部门（按当前组织范围查看审计），删除 / 失效后仍按快照里的部门判断。 */
async function audit(
  tx: Tx,
  ctx: OfferContext,
  action: string,
  id: string,
  before: OfferRow | null,
  after: OfferRow | null,
) {
  await recordAudit(tx, {
    scope: { orgId: (after ?? before)?.departmentId ?? null },
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `offer.${action}`,
    objectType: 'offer',
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

/** 加锁读取并核对范围；范围外与不存在同为 404。 */
export async function lockOffer(tx: Tx, ctx: OfferContext, id: string): Promise<OfferRow> {
  const [row] = await tx
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', 'Offer 不存在');
  requireOfferInScope(ctx, row);
  return row;
}

export async function loadOffer(tx: Tx, ctx: OfferContext, id: string): Promise<OfferRow> {
  const [row] = await tx
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id)));
  if (!row) throw new AppError('NOT_FOUND', 'Offer 不存在');
  requireOfferInScope(ctx, row);
  return row;
}

function toColumns(values: Readonly<Record<string, unknown>>) {
  const result: Record<string, unknown> = {};
  for (const field of OFFER_FIELDS) {
    if (!(field in values)) continue;
    const value = values[field];
    result[field] = MONEY.includes(field) && typeof value === 'number' ? value.toFixed(2) : (value ?? null);
  }
  return result as Partial<typeof offers.$inferInsert>;
}

/** 新部门须在当前范围内（新建时创建人即本人，使用用户维度同样放行）。 */
function requireDepartment(ctx: OfferContext, departmentId: string | null | undefined, createdBy: string) {
  if (departmentId) requireOfferInScope(ctx, { departmentId, createdBy });
}

function requireComplete(type: OfferType | null, values: Readonly<Record<string, unknown>>) {
  const missing = missingOfferFields(type, values);
  if (missing.length) failPlan({ ok: false, reason: 'OFFER_FORM_INCOMPLETE', fields: missing });
}

/** 引用不存在或跨租户（复合外键）→ 400；被其他 Offer 引用时不能删除 → 409。 */
async function guarded<T>(work: () => Promise<T>, deleting = false): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (pgErrorCode(error) !== '23503') throw error;
    if (deleting) throw new AppError('CONFLICT', 'Offer 已被其他 Offer 引用', { reason: 'OFFER_REFERENCED' });
    throw new AppError('VALIDATION_FAILED', 'Offer 引用的对象不存在', { reason: 'OFFER_REFERENCE_INVALID' });
  }
}

/** 三个新建入口（DEC-527③）：实习两个入口类型固定为实习；校招生提前实习须选一份校招 Offer 并带出基本信息。 */
export async function createOffer(tx: Tx, ctx: OfferContext, input: OfferCreateInput) {
  const { entry, offerType, source, campusOfferId, ...fields } = input;
  if (entry !== 'offer' && offerType && offerType !== 'intern')
    throw new AppError('VALIDATION_FAILED', '实习入口的 Offer 类型只能是实习', { reason: 'OFFER_TYPE_MISMATCH' });
  if (entry === 'offer' && offerType === 'intern')
    throw new AppError('VALIDATION_FAILED', '实习 Offer 请从新建实习 Offer 入口创建', {
      reason: 'OFFER_TYPE_MISMATCH',
    });
  if (entry !== 'offer' && source && source !== 'new_hire')
    throw new AppError('VALIDATION_FAILED', '实习 Offer 的来源只能是新增人员', { reason: 'OFFER_SOURCE_INVALID' });
  if ((entry === 'campus_early_intern') !== !!campusOfferId)
    throw new AppError('VALIDATION_FAILED', '校招生提前实习须选择一份校招 Offer', { reason: 'OFFER_CAMPUS_REQUIRED' });
  const values: Record<string, unknown> = { ...fields };
  if (campusOfferId) {
    const campus = await loadOffer(tx, ctx, campusOfferId);
    if (campus.offerType !== 'campus' || campus.status === 'invalid')
      throw new AppError('VALIDATION_FAILED', '所选 Offer 不是有效的校招 Offer', { reason: 'OFFER_CAMPUS_REQUIRED' });
    for (const field of CAMPUS_CARRIED) values[field] ??= campus[field as keyof OfferRow];
  }
  const type = entry === 'offer' ? (offerType ?? null) : 'intern';
  requireComplete(type, values);
  requireDepartment(ctx, values.departmentId as string | null, ctx.userId);
  const [row] = await guarded(() =>
    tx
      .insert(offers)
      .values({
        ...toColumns(values),
        tenantId: ctx.tenantId,
        entry,
        offerType: type,
        source: source ?? 'new_hire',
        campusOfferId: campusOfferId ?? null,
        createdBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning(),
  );
  await audit(tx, ctx, 'create', row!.id, null, row!);
  return offerDto(row!);
}

async function save(tx: Tx, ctx: OfferContext, before: OfferRow, action: string, patch: Partial<OfferRow>) {
  const [after] = await guarded(() =>
    tx
      .update(offers)
      .set({ ...patch, revision: before.revision + 1, updatedAt: ctx.now })
      .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, before.id)))
      .returning(),
  );
  await audit(tx, ctx, action, before.id, before, after!);
  return offerDto(after!);
}

function requireEditable(row: OfferRow) {
  if (!offerEditable(facts(row)))
    throw new AppError('CONFLICT', '只有待发且不在审批中的 Offer 可以编辑或删除', { reason: 'OFFER_NOT_EDITABLE' });
}

/** Offer 编辑（待发、非审批中）：类型、入口、来源新建后不改；保存后的整份字段按类型重新校验必填。 */
export async function updateOffer(tx: Tx, ctx: OfferContext, id: string, input: OfferUpdateInput) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  requireEditable(before);
  const patch = toColumns(input);
  requireComplete(typeOf(before), { ...offerDto(before), ...input });
  if ('departmentId' in input) requireDepartment(ctx, input.departmentId, before.createdBy);
  return save(tx, ctx, before, 'update', patch);
}

/** 删除只限待发（34 §2.1 行操作矩阵）；保留删除前快照在审计里（AGENTS §5）。 */
export async function deleteOffer(tx: Tx, ctx: OfferContext, id: string) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  requireEditable(before);
  await guarded(() => tx.delete(offers).where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id))), true);
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}

/** 复制（失效后唯一的出口，OF-R7）：新 Offer 回到待发 / 未发起审批，记下被复制的 Offer；状态表单字段不复制。 */
export async function copyOffer(tx: Tx, ctx: OfferContext, id: string) {
  const source = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, source.revision);
  if (source.status !== 'invalid')
    throw new AppError('CONFLICT', '只有失效的 Offer 可以复制', { reason: 'OFFER_COPY_NOT_ALLOWED' });
  const fields = Object.fromEntries(OFFER_FIELDS.map((field) => [field, source[field as keyof OfferRow]]));
  requireDepartment(ctx, source.departmentId, ctx.userId);
  const [row] = await guarded(() =>
    tx
      .insert(offers)
      .values({
        ...(fields as Partial<typeof offers.$inferInsert>),
        tenantId: ctx.tenantId,
        entry: source.entry,
        offerType: source.offerType,
        source: source.source,
        campusOfferId: source.campusOfferId,
        copiedFromOfferId: source.id,
        createdBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning(),
  );
  await audit(tx, ctx, 'copy', row!.id, null, row!);
  return offerDto(row!);
}

/** 转移状态（AC-OF-08 / 09 / 17）：拒绝原因只能选启用的字典项。 */
export async function transferOffer(tx: Tx, ctx: OfferContext, id: string, input: OfferTransferInput) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  const plan = planOfferTransition(facts(before), input.target, input);
  if (!plan.ok) failPlan(plan);
  if (plan.patch.refusalReasonCode)
    await assertOfferDictionaryEnabled(tx, ctx.tenantId, 'refusal-reasons', plan.patch.refusalReasonCode);
  return save(tx, ctx, before, 'transfer', plan.patch);
}

/** 失效（OF-R7）：确定即失效，记失效时间；不可恢复。 */
export async function invalidateOffer(tx: Tx, ctx: OfferContext, id: string, input: OfferInvalidateInput) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  const plan = planOfferInvalidation(facts(before), input);
  if (!plan.ok) failPlan(plan);
  await assertOfferDictionaryEnabled(tx, ctx.tenantId, 'invalid-reasons', plan.patch.invalidReasonCode);
  return save(tx, ctx, before, 'invalidate', { ...plan.patch, invalidAt: ctx.now });
}

/** 转移状态表单：候选目标与已保存的拒绝时间 / 原因 / 备注（再次选“已拒绝”时带出原值，DEC-532①）。 */
export async function offerTransferForm(tx: Tx, ctx: OfferContext, id: string) {
  const row = await loadOffer(tx, ctx, id);
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    targets: OFFER_TRANSITIONS[row.status as OfferStatus],
    acceptTime: row.acceptTime,
    refusalTime: row.refusalTime,
    refusalReasonCode: row.refusalReasonCode,
    refusalRemark: row.refusalRemark,
  };
}

/** OF-R3 发送前拦截判定（发送动作在 BE-14b）：返回是否允许与机读原因。 */
export async function offerSendCheck(tx: Tx, ctx: OfferContext, id: string) {
  const row = await loadOffer(tx, ctx, id);
  const setting = (await readEffectiveSetting(tx, ctx.tenantId, OFFER_SEND_APPROVAL_KEY)).value;
  const plan = planOfferSend(
    facts(row),
    validOfferSendApprovalSetting(setting) ? setting : OFFER_SEND_APPROVAL_DEFAULT,
  );
  return {
    id: row.id,
    offerType: effectiveOfferType(typeOf(row)),
    allowed: plan.ok,
    reason: plan.ok ? null : plan.reason,
  };
}

export async function offerDetail(tx: Tx, ctx: OfferContext, id: string, allowed: (a: OfferRowAction) => boolean) {
  return withActions(await loadOffer(tx, ctx, id), allowed);
}

export interface OfferListQuery {
  readonly view: OfferView;
  readonly filters: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly offset: number;
}

const TEXT_FILTERS = new Set(['name', 'personalEmail', 'mobile', 'idNumber', 'appliedPosition', 'workPlace']);

/** 列表按视图的状态 / 审批子状态、筛选条件与数据范围在 SQL 中过滤，范围谓词先于分页。 */
export async function listOffers(
  tx: Tx,
  ctx: OfferContext,
  query: OfferListQuery,
  allowed: (action: OfferRowAction) => boolean,
) {
  const conditions: SQL[] = [
    sql`${offers.tenantId} = ${ctx.tenantId}`,
    scopeSql(ctx.scope, { org: sql`${offers.departmentId}`, creator: sql`${offers.createdBy}` }),
  ];
  if (query.view.statuses) conditions.push(sql`${offers.status} = ANY(${`{${query.view.statuses.join(',')}}`})`);
  if (query.view.approvalStatus) conditions.push(sql`${offers.approvalStatus} = ${query.view.approvalStatus}`);
  for (const [field, value] of Object.entries(query.filters)) {
    const column = (offers as unknown as Record<string, AnyColumn>)[field]!;
    conditions.push(
      TEXT_FILTERS.has(field)
        ? sql`${column} ILIKE ${`%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`
        : sql`${column}::text = ${value}`,
    );
  }
  const where = sql.join(conditions, sql` AND `);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(offers)
    .where(where);
  const rows = await tx
    .select()
    .from(offers)
    .where(where)
    .orderBy(desc(offers.createdAt), desc(offers.id))
    .limit(query.limit)
    .offset(query.offset);
  return { total: count!.total, items: rows.map((row) => withActions(row, allowed)) };
}
