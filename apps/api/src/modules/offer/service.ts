/**
 * Offer 命令与查询（R2 BE-14a C1，DEC-581；34 §2.1、OF-R1 / R12，DEC-527③ / 532⑤）：新建（三个入口）、编辑、删除、复制、
 * 列表 / 详情。按类型必填与可编辑判定在领域纯函数（@italent/domain offer/rules.ts），这里负责加锁、范围、落库与审计。
 * 状态转移、失效、行操作与 OF-R3 在 C2（BE-14a2）。
 */
import { and, desc, eq, offers, pgErrorCode, sql, type Tx } from '@italent/db';
import {
  MODULE_OBJECTS,
  missingOfferFields,
  OFFER_FIELDS,
  OFFER_REFUSAL_FIELDS,
  offerEditable,
  type OfferApprovalStatus,
  type OfferField,
  type OfferStatus,
  type OfferType,
  type OfferView,
  tenantLocalDate,
} from '@italent/domain';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { visibleEmploymentRecords } from '../employment/visibility.js';
import { scopeSql } from '../permission/module-access.js';
import { JOB_OBJECT_CODES, visibleJob } from '../permission/module-route-access.js';
import { assertOfferRevision, requireOfferInScope, type OfferContext } from './context.js';
import type { OfferCreateInput, OfferUpdateInput } from './input.js';

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
export async function lockOffer(
  tx: Tx,
  ctx: OfferContext,
  id: string,
  strength: 'update' | 'share' = 'update',
): Promise<OfferRow> {
  const [row] = await tx
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id)))
    .for(strength);
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

const invalidReference = () =>
  new AppError('VALIDATION_FAILED', 'Offer 引用的对象不存在', { reason: 'OFFER_REFERENCE_INVALID' });

/**
 * 引用按被引用对象自己的当前范围校验（审查 #394 P2-02）；不存在与范围外同为 400 OFFER_REFERENCE_INVALID，不暴露存在性。
 * - 直线上级 / 虚线上级 / HRBP：按员工对象（TenantBase.Employee）自己的当前范围可见；员工创建人未知时不按“使用用户”维度
 *   放行（保守取严）；
 * - 职位（有组织）/ 职务 / 职级（无组织）：按职务体系对象各自的范围（visibleJob，无组织对象只认看全部或创建人，DEC-121）；
 * - 合同主体：合同主数据只认看全部（与合同模块读主数据同口径，contracts/routes.ts requireMasterScope）。
 * 看全部时存在性仍由（租户, ID）复合外键保证。
 */
const PERSON_REFS = ['directManagerId', 'dottedManagerId', 'hrbpId'] as const;
const JOB_REFS = [
  ['positionId', 'positions'],
  ['postId', 'posts'],
  ['levelId', 'levels'],
] as const;
async function requireReferences(tx: Tx, ctx: OfferContext, values: Readonly<Record<string, unknown>>) {
  const scopeOf = ctx.scopeOf;
  if (!scopeOf) throw new AppError('SERVICE_UNAVAILABLE', 'Offer 写入缺少事务内范围解析');
  const ids = PERSON_REFS.map((field) => values[field]).filter((id): id is string => typeof id === 'string');
  if (ids.length) {
    const targets = ids.map((employeeId) => ({ employeeId, departmentId: null, creatorId: null }));
    const employees = await scopeOf(MODULE_OBJECTS.employee.code);
    if ((await visibleEmploymentRecords(tx, ctx.tenantId, employees, targets)).includes(false))
      throw invalidReference();
  }
  for (const [field, kind] of JOB_REFS) {
    const id = values[field];
    if (typeof id !== 'string') continue;
    const scope = await scopeOf(JOB_OBJECT_CODES[kind]);
    if (scope.all) continue;
    await visibleJob(tx, ctx, scope, kind, id, tenantLocalDate(ctx.now, ctx.timezone)).catch((error: unknown) => {
      throw error instanceof AppError && error.code === 'NOT_FOUND' ? invalidReference() : error;
    });
  }
  if (typeof values.contractCompanyId === 'string' && !(await scopeOf(MODULE_OBJECTS.contractCompany.code)).all)
    throw invalidReference();
}

function requireComplete(type: OfferType | null, values: Readonly<Record<string, unknown>>) {
  const missing = missingOfferFields(type, values);
  if (missing.length)
    throw new AppError('VALIDATION_FAILED', '必填项未填写', { reason: 'OFFER_FORM_INCOMPLETE', fields: missing });
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

/** 入口、类型、来源与校招 Offer 的组合校验（DEC-527③）：实习两个入口类型固定为实习。 */
function requireEntry(input: OfferCreateInput) {
  const { entry, offerType, source, campusOfferId } = input;
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
}

const present = (values: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));

/**
 * 校招生提前实习：从所选校招 Offer 带出请求里没填的基本信息（只取有值的项）。校招 Offer 待发时可编辑，读时加共享锁，
 * 本事务提交前他人改不了它（审查 #394 P2-03）。
 */
async function campusCarried(tx: Tx, ctx: OfferContext, input: OfferCreateInput) {
  if (!input.campusOfferId) return {};
  const campus = await lockOffer(tx, ctx, input.campusOfferId, 'share');
  if (campus.offerType !== 'campus' || campus.status === 'invalid')
    throw new AppError('VALIDATION_FAILED', '所选 Offer 不是有效的校招 Offer', { reason: 'OFFER_CAMPUS_REQUIRED' });
  const missing = CAMPUS_CARRIED.filter((field) => input[field as keyof OfferCreateInput] === undefined);
  return present(Object.fromEntries(missing.map((field) => [field, campus[field as keyof OfferRow]])));
}

/**
 * 新建实际写入的字段（审查 #394 P2-01）：请求字段 + 从校招 Offer 继承的字段。字段编辑权按它校验（事务内的
 * CommandGuard.before），新建也按它落库：路由按事务冻结这份结果，判定与落库共用同一个对象（P2-03）。
 */
export async function offerCreateWrites(tx: Tx, ctx: OfferContext, input: OfferCreateInput) {
  requireEntry(input);
  return { ...input, ...(await campusCarried(tx, ctx, input)) };
}

export type OfferCreateWrites = Awaited<ReturnType<typeof offerCreateWrites>>;

/** 复制实际写入的字段（审查 #394 P2-01）：被复制 Offer 上有值的业务字段与入口 / 类型 / 来源 / 校招 Offer。 */
export function offerCopyWrites(source: OfferRow) {
  return present({
    entry: source.entry,
    offerType: source.offerType,
    source: source.source,
    campusOfferId: source.campusOfferId,
    ...Object.fromEntries(OFFER_FIELDS.map((field) => [field, offerDto(source)[field]])),
  });
}

/**
 * 三个新建入口（DEC-527③）：实习两个入口类型固定为实习；校招生提前实习须选一份校招 Offer 并带出基本信息。
 * writes 是本事务判定字段编辑权时用的同一份展开结果（offerCreateWrites），这里不再读校招 Offer。
 */
export async function createOffer(tx: Tx, ctx: OfferContext, writes: OfferCreateWrites) {
  const { entry, offerType, source, campusOfferId, ...values } = writes;
  const type = entry === 'offer' ? (offerType ?? null) : 'intern';
  requireComplete(type, values);
  requireDepartment(ctx, values.departmentId as string | null, ctx.userId);
  await requireReferences(tx, ctx, values);
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
  if (!offerEditable({ status: row.status as OfferStatus, approvalStatus: row.approvalStatus as OfferApprovalStatus }))
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
  await requireReferences(tx, ctx, input);
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

/**
 * 复制（失效后唯一的出口，OF-R7）：新 Offer 回到待发 / 未发起审批，记下被复制的 Offer；状态表单字段不复制。
 * source 是本事务判定字段编辑权时锁读的同一行（lockOffer），这里不再读第二次（审查 #394 P2-03）。
 */
export async function copyOffer(tx: Tx, ctx: OfferContext, source: OfferRow) {
  assertOfferRevision(ctx.expectedRevision, source.revision);
  if (source.status !== 'invalid')
    throw new AppError('CONFLICT', '只有失效的 Offer 可以复制', { reason: 'OFFER_COPY_NOT_ALLOWED' });
  const fields = Object.fromEntries(OFFER_FIELDS.map((field) => [field, source[field as keyof OfferRow]]));
  requireDepartment(ctx, source.departmentId, ctx.userId);
  await requireReferences(tx, ctx, fields);
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

export async function offerDetail(tx: Tx, ctx: OfferContext, id: string) {
  return offerDto(await loadOffer(tx, ctx, id));
}

export interface OfferListQuery {
  readonly view: OfferView;
  readonly filters: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly offset: number;
}

const TEXT_FILTERS = new Set(['name', 'personalEmail', 'mobile', 'idNumber', 'appliedPosition', 'workPlace']);

/** 列表按视图的状态 / 审批子状态、筛选条件与数据范围在 SQL 中过滤，范围谓词先于分页。 */
export async function listOffers(tx: Tx, ctx: OfferContext, query: OfferListQuery) {
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
  return { total: count!.total, items: rows.map(offerDto) };
}
