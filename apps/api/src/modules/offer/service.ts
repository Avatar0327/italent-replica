/**
 * Offer 命令与查询（R2 BE-14a，DEC-581；34 §2.1、OF-R1 / R3 / R7 / R12，DEC-527～537）：新建（三个入口）、编辑、删除、复制、
 * 列表 / 详情（C1）；状态转移、失效、转移表单、行操作与 OF-R3 发送判定（C2，BE-14a2）。规则在领域纯函数
 * （@italent/domain offer/rules.ts、views.ts），这里负责加锁、范围、字典校验、落库与审计。
 */
import { and, asc, desc, eq, offerSendRecords, offers, pgErrorCode, sql, type Tx } from '@italent/db';
import {
  MODULE_OBJECTS,
  missingOfferFields,
  OFFER_FIELDS,
  OFFER_REAPPROVAL_INVALID_REASON,
  OFFER_REFUSAL_FIELDS,
  OFFER_REVIEW_FIELDS_DEFAULT,
  OFFER_REVIEW_FIELDS_KEY,
  OFFER_SEND_APPROVAL_DEFAULT,
  OFFER_SEND_APPROVAL_KEY,
  OFFER_WIRED_ROW_ACTIONS,
  birthDateFromIdCard,
  effectiveOfferType,
  offerEditable,
  offerEditableWithSync,
  offerRowActions,
  offerSyncKind,
  offerTransferTargets,
  offerTransitionCancelsEntry,
  planOfferInvalidation,
  planOfferSend,
  planOfferTransition,
  reapprovalAfterEdit,
  validOfferReviewFieldsSetting,
  validOfferSendApprovalSetting,
  type OfferApprovalStatus,
  type OfferReviewFieldsSetting,
  type OfferSendApprovalSetting,
  type OfferField,
  type OfferPlan,
  type OfferRowAction,
  type OfferStateFacts,
  type OfferStatus,
  type OfferType,
  type OfferView,
  tenantLocalDate,
} from '@italent/domain';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { FieldAccess } from '../approval/context.js';
import { auditActor } from '../../system-actor.js';
import { visibleEmploymentRecords } from '../employment/visibility.js';
import { scopeSql } from '../permission/module-access.js';
import { JOB_OBJECT_CODES, visibleJob } from '../permission/module-route-access.js';
import { withApprovalProgress } from './approval-progress.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertOfferRevision, requireOfferInScope, type OfferContext } from './context.js';
import { requireEnabledOfferReason } from './dictionaries.js';
import { currentEntryIds } from './entry-link.js';
import { requireQuotaConfirmed } from './establishment.js';
import { cancelLinkedEntry, deleteLinkedEntry, pushEditToEntry, readOfferLinkageSetting } from './linkage.js';
import type { OfferPush } from './linkage.js';
import { lockOfferSyncScope } from './sync-lock.js';
import { requireNotBlacklisted, type OfferIdentity } from './identity.js';
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

/** 改动这几项时重新做黑名单校验（OF-R2）。 */
const IDENTITY_FIELDS = ['name', 'mobile', 'personalEmail', 'idNumber'] as const;

const typeOf = (row: Pick<OfferRow, 'offerType'>) => row.offerType as OfferType | null;

/** OF-R3 发送前须审批与 OF-R4 必审字段两项配置（取值不合法时按出厂值，与 send-check 同口径）。 */
export async function readOfferApprovalSettings(tx: Tx, tenantId: string) {
  const send = (await readEffectiveSetting(tx, tenantId, OFFER_SEND_APPROVAL_KEY)).value;
  const review = (await readEffectiveSetting(tx, tenantId, OFFER_REVIEW_FIELDS_KEY)).value;
  return {
    send: validOfferSendApprovalSetting(send) ? send : OFFER_SEND_APPROVAL_DEFAULT,
    review: validOfferReviewFieldsSetting(review) ? review : OFFER_REVIEW_FIELDS_DEFAULT,
  } satisfies { send: OfferSendApprovalSetting; review: OfferReviewFieldsSetting };
}

export const facts = (row: OfferRow): OfferStateFacts => ({
  status: row.status as OfferStatus,
  approvalStatus: row.approvalStatus as OfferApprovalStatus,
  offerType: typeOf(row),
  // 联动只认待入职；实习转正产物（sync_target = intern_regularization）没有可取消 / 删除的待入职
  hasPendingEntry: row.pendingEntryBusinessId !== null && row.syncTarget !== 'intern_regularization',
});

/** 接口形状：金额转数字；拒绝时间 / 原因 / 备注只在“已拒绝”时出现（DEC-532①：退回待发后保留但详情不显示）。 */
export function offerDto(row: OfferRow, currentEntryId?: string) {
  const { tenantId: _tenant, ...rest } = row;
  const dto: Record<string, unknown> = {
    ...rest,
    hasPendingEntry: row.pendingEntryBusinessId !== null,
    // 待入职记录经改期 / 编辑换日期会换新 ID：读路径传入沿记录链解析出的最新 ID（sync.ts currentEntryIds）
    pendingEntryBusinessId: currentEntryId ?? row.pendingEntryBusinessId,
    syncedContractKind: row.syncStatus === 'success' ? offerSyncKind(typeOf(row)).contractKind : null,
  };
  for (const field of MONEY) {
    const value = row[field as keyof OfferRow];
    dto[field] = value === null ? null : Number(value);
  }
  if (row.status !== 'rejected') for (const field of OFFER_REFUSAL_FIELDS) delete dto[field];
  return dto;
}

/** 审计归属录用部门（按当前组织范围查看审计），删除 / 失效后仍按快照里的部门判断。 */
export async function audit(
  tx: Tx,
  ctx: Pick<OfferContext, 'tenantId' | 'userId' | 'commandId' | 'now'>,
  action: string,
  id: string,
  before: (OfferRow & { readonly sendRecords?: readonly object[] }) | null,
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

/**
 * 删除 / 失效 / 编辑改写 Offer 的取锁单一入口（F-219，DEC-431①）：先按 ID 升序锁本 Offer 所在的在途批量单，再锁 Offer，
 * 取到 Offer 锁后复核关联未变（变了即 409）。与审批动作（批量单 → 子表 Offer 升序 → 实例）同序，
 * 删除 B × 失效 A 都先排在批量单上，不会一个先锁 Offer、一个先锁批量单而成环（40P01）。
 */
export async function lockOfferWithBatches(tx: Tx, ctx: OfferContext, id: string): Promise<OfferRow> {
  const { lockOfferBatches } = await import('./approval.js');
  const recheck = await lockOfferBatches(tx, ctx.tenantId, id);
  const row = await lockOffer(tx, ctx, id);
  await recheck();
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
    if (deleting)
      throw new AppError('CONFLICT', 'Offer 已被其他 Offer 或批量审批单引用', { reason: 'OFFER_REFERENCED' });
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
  const writes = { ...input, ...(await campusCarried(tx, ctx, input)) };
  // OF-R2：身份证号带出出生日期（未填时）。派生值进同一份载荷：字段编辑权、落库共用它，无权字段整单拒绝（DEC-455①）
  const birthDate = writes.birthDate === undefined ? birthDateFromIdCard(writes.idType, writes.idNumber) : null;
  return birthDate ? { ...writes, birthDate } : writes;
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
  await requireNotBlacklisted(tx, ctx, values);
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

export async function save(tx: Tx, ctx: OfferContext, before: OfferRow, action: string, patch: Partial<OfferRow>) {
  const [after] = await guarded(() =>
    tx
      .update(offers)
      .set({ ...patch, revision: before.revision + 1, updatedAt: ctx.now })
      .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, before.id)))
      .returning(),
  );
  await audit(tx, ctx, action, before.id, before, after!);
  // 写响应同样给沿记录链解析后的最新待入职 ID（编辑并同步会替换记录换 ID）
  return offerDto(after!, (await currentEntryIds(tx, ctx.tenantId, [after!])).get(after!.id));
}

/**
 * 审批结果回写审批子状态（BE-14a3）：审批中心以可信身份调用（审批不授予范围，DEC-057），只改审批子状态，留审计。
 */
export function saveApprovalStatus(
  tx: Tx,
  ctx: Pick<OfferContext, 'tenantId' | 'userId' | 'commandId' | 'now'>,
  before: OfferRow,
  approvalStatus: OfferApprovalStatus,
) {
  return save(tx, ctx as OfferContext, before, 'approval', { approvalStatus });
}

function requireEditable(row: OfferRow) {
  if (!offerEditableWithSync(facts(row)))
    throw new AppError('CONFLICT', '只有待发（非审批中）、已发或已接受的 Offer 可以编辑', {
      reason: 'OFFER_NOT_EDITABLE',
    });
}

/** 编辑并同步推送结果落在 Offer 的同步列上（同 #407 的同步成功 / 失败口径）；没有推送则不动。 */
function pushColumns(push: OfferPush, ctx: OfferContext, before: OfferRow): Partial<OfferRow> {
  if (push === 'skipped' || push === 'unchanged') return {};
  const base = { syncAttempts: before.syncAttempts + 1, lastSyncAt: ctx.now };
  if (push === 'pushed')
    return { ...base, syncStatus: 'success', syncReason: null, syncMessage: null, syncedAt: ctx.now };
  return { ...base, syncStatus: 'failed', syncReason: push.failed.reason, syncMessage: push.failed.message };
}

/**
 * Offer 编辑（待发非审批中），及已发 / 已接受的“编辑并同步”（OF-R14）：类型、入口、来源新建后不改；保存后的整份字段按类型
 * 重新校验必填。syncPendingEntry（默认 false）为 true 时，仅已同步且未取消入职的待入职被推送；推送遇业务规则拒绝，Offer 编辑保留、
 * 原因记在同步列（同步状态“失败”），响应 entrySync 给出结果。
 * OF-R4：审批通过后改了必审字段（该类型开了“发送前须审批”）→ 按“允许再次发起”开关分流：开 = 回待发 / 未发起审批（已发 / 已接受
 * 同时取消待入职）；关 = 失效原 Offer（有待入职则删除）并按编辑后的值复制一份新 Offer，响应是新 Offer（replacedOfferId = 原 ID）。
 */
export async function updateOffer(
  tx: Tx,
  ctx: OfferContext,
  id: string,
  input: OfferUpdateInput,
  options: { readonly syncPendingEntry?: boolean; readonly approvalFields: FieldAccess },
) {
  const { syncPendingEntry = false, approvalFields } = options;
  const before = await lockOfferWithBatches(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  requireEditable(before);
  const patch = toColumns(input);
  requireComplete(typeOf(before), { ...offerDto(before), ...input });
  if ('departmentId' in input) requireDepartment(ctx, input.departmentId, before.createdBy);
  await requireReferences(tx, ctx, input);
  if (IDENTITY_FIELDS.some((field) => field in input))
    await requireNotBlacklisted(tx, ctx, { ...offerDto(before), ...input } as OfferIdentity);
  const changed = OFFER_FIELDS.filter(
    (field) => field in patch && patch[field as keyof typeof patch] !== before[field as keyof OfferRow],
  );
  const settings = await readOfferApprovalSettings(tx, ctx.tenantId);
  const linkage = await readOfferLinkageSetting(tx, ctx.tenantId);
  const reapproval = reapprovalAfterEdit(facts(before), changed, settings.send, settings.review, linkage);
  if (reapproval === 'replace') return replaceOffer(tx, ctx, before, patch, approvalFields);
  const restart = reapproval === 'restart';
  // 已发 / 已接受重新审批：回待发，已有待入职取消入职（Offer 自己不因此变已拒绝）
  if (restart && before.status !== 'pending') await cancelLinkedEntry(tx, ctx, before);
  const next: Partial<OfferRow> = {
    ...patch,
    ...(restart ? { approvalStatus: 'unsubmitted' as const } : {}),
    ...(restart && before.status !== 'pending' ? { status: 'pending' as const } : {}),
  } as Partial<OfferRow>;
  const pushable = syncPendingEntry && !restart && before.status !== 'pending';
  const push: OfferPush = pushable ? await pushEditToEntry(tx, ctx, { ...before, ...next } as OfferRow) : 'skipped';
  const saved = await save(tx, ctx, before, 'update', { ...next, ...pushColumns(push, ctx, before) });
  // OF-R4 开：原单回到待发 / 未发起审批后，同一事务里实际发起审批（新 running 实例 + 待办）
  if (restart) {
    const { restartOfferApproval } = await import('./approval.js');
    return restartOfferApproval(tx, ctx, id, approvalFields);
  }
  return pushable ? { ...saved, entrySync: typeof push === 'string' ? push : 'failed' } : saved;
}

/** OF-R4 关分支：原 Offer 系统失效（有待入职则一并删除），按编辑后的字段值复制一份待发 / 未发起审批的新 Offer。 */
async function replaceOffer(
  tx: Tx,
  ctx: OfferContext,
  before: OfferRow,
  patch: Partial<typeof offers.$inferInsert>,
  approvalFields: FieldAccess,
) {
  if (facts(before).hasPendingEntry) await deleteLinkedEntry(tx, ctx, before);
  await save(tx, ctx, before, 'invalidate', {
    status: 'invalid',
    invalidReasonCode: OFFER_REAPPROVAL_INVALID_REASON,
    invalidRemark: '审批通过后修改必审字段且不允许再次发起审批：失效原 Offer 并复制新 Offer',
    invalidAt: ctx.now,
    pendingEntryBusinessId: null,
  });
  const fields = {
    ...Object.fromEntries(OFFER_FIELDS.map((field) => [field, before[field as keyof OfferRow]])),
    ...patch,
  };
  const copy = await insertCopy(tx, ctx, before, fields);
  // 复制的新单同事务发起审批（AC-OF-02）；首节点为空等拒绝时整笔回滚，原单不失效
  const { restartOfferApproval } = await import('./approval.js');
  const started = await restartOfferApproval(tx, ctx, copy.id as string, approvalFields);
  return { ...started, replacedOfferId: before.id };
}

/**
 * 删除只限待发（34 §2.1 行操作矩阵）；保留删除前快照在审计里（AGENTS §5）。退回待发的 Offer 可能有发送历史：发送记录
 * 随 Offer 级联删除，删除前的发送历史（先后、类型、收件人、抄送 / 密送、投递状态）一并写进审计快照（审查 #406 P2-03）。
 */
export async function deleteOffer(tx: Tx, ctx: OfferContext, id: string) {
  const before = await lockOfferWithBatches(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  if (!offerEditable(facts(before)))
    throw new AppError('CONFLICT', '只有待发且不在审批中的 Offer 可以删除', { reason: 'OFFER_NOT_EDITABLE' });
  // 被驳回 / 撤回后待重新发起的单个 Offer 审批随删除作废（同任职申请删除，DEC-103）
  const { cancelOfferApprovals } = await import('./approval.js');
  await cancelOfferApprovals(tx, ctx, id);
  const sendRecords = await tx
    .select({
      kind: offerSendRecords.kind,
      status: offerSendRecords.status,
      recipient: offerSendRecords.recipient,
      cc: offerSendRecords.cc,
      bcc: offerSendRecords.bcc,
      sentBy: offerSendRecords.sentBy,
      createdAt: offerSendRecords.createdAt,
    })
    .from(offerSendRecords)
    .where(and(eq(offerSendRecords.tenantId, ctx.tenantId), eq(offerSendRecords.offerId, id)))
    .orderBy(asc(offerSendRecords.createdAt), asc(offerSendRecords.id));
  await guarded(() => tx.delete(offers).where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, id))), true);
  await audit(tx, ctx, 'delete', id, sendRecords.length ? { ...before, sendRecords } : before, null);
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
  return insertCopy(tx, ctx, source, fields);
}

/** 复制落库（失效后的复制与 OF-R4 关分支共用）：新 Offer 待发 / 未发起审批，记下被复制的 Offer。 */
async function insertCopy(tx: Tx, ctx: OfferContext, source: OfferRow, fields: Record<string, unknown>) {
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

/** 写命令的结果对象：重放时复核仍在当前范围（撤范围后同键重放 404）。 */
export const offerStillVisible = async (tx: Tx, ctx: OfferContext, body: unknown) => {
  const id = (body as { id?: string } | null)?.id;
  if (id) await loadOffer(tx, ctx, id);
};

/** 当前用户可用的行操作判定（按权限）；与已接线动作取交集后挂到列表行 / 详情上。 */
export type OfferActionFilter = (action: OfferRowAction) => boolean;

/** 行操作（AC-OF-16 / 19 / 20）：原站矩阵只保留已接线、且当前用户有权的动作（OFFER_WIRED_ROW_ACTIONS）。 */
function withActions(row: OfferRow, allowed: OfferActionFilter, current?: ReadonlyMap<string, string>) {
  const usable = (action: OfferRowAction) => OFFER_WIRED_ROW_ACTIONS.includes(action) && allowed(action);
  const actions = offerRowActions(facts(row));
  return {
    ...offerDto(row, current?.get(row.id)),
    rowActions: { primary: actions.primary.filter(usable), menu: actions.menu.filter(usable) },
  };
}

export async function offerDetail(tx: Tx, ctx: OfferContext, id: string, allowed: OfferActionFilter) {
  const row = await loadOffer(tx, ctx, id);
  const current = await currentEntryIds(tx, ctx.tenantId, [row]);
  const [dto] = await withApprovalProgress(tx, ctx.tenantId, [withActions(row, allowed, current)]);
  return dto!;
}

export interface OfferListQuery {
  readonly view: OfferView;
  readonly filters: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly offset: number;
}

const TEXT_FILTERS = new Set(['name', 'personalEmail', 'mobile', 'idNumber', 'appliedPosition', 'workPlace']);

/** 视图自己的状态 / 审批子状态条件；Offer 列表与人事看板（BE-12b）共用。 */
export function offerViewConditions(view: Pick<OfferView, 'statuses' | 'approvalStatus'>): SQL[] {
  const conditions: SQL[] = [];
  if (view.statuses) conditions.push(sql`${offers.status} = ANY(${`{${view.statuses.join(',')}}`})`);
  if (view.approvalStatus) conditions.push(sql`${offers.approvalStatus} = ${view.approvalStatus}`);
  return conditions;
}

/** 列表按视图的状态 / 审批子状态、筛选条件与数据范围在 SQL 中过滤，范围谓词先于分页。 */
export async function listOffers(tx: Tx, ctx: OfferContext, query: OfferListQuery, allowed: OfferActionFilter) {
  const conditions: SQL[] = [
    sql`${offers.tenantId} = ${ctx.tenantId}`,
    scopeSql(ctx.scope, { org: sql`${offers.departmentId}`, creator: sql`${offers.createdBy}` }),
  ];
  conditions.push(...offerViewConditions(query.view));
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
  const current = await currentEntryIds(tx, ctx.tenantId, rows);
  const items = rows.map((row) => withActions(row, allowed, current));
  return { total: count!.total, items: await withApprovalProgress(tx, ctx.tenantId, items) };
}

const PLAN_MESSAGES: Readonly<Record<string, string>> = {
  OFFER_TRANSITION_INVALID: '当前状态不能转移到目标状态',
  OFFER_APPROVAL_IN_PROGRESS: 'Offer 审批中，不能执行该操作',
  OFFER_ENTRY_LINKED: '已有待入职记录，请在入职管理办理入职，Offer 会随之变为已入职',
  OFFER_FORM_INCOMPLETE: '必填项未填写',
  OFFER_INVALIDATION_NOT_ALLOWED: '当前 Offer 不能失效',
  OFFER_NOT_PENDING: '只有待发或已发的 Offer 可以发送',
  OFFER_APPROVAL_REQUIRED: '该类型 Offer 发送前须审批通过',
};

/** 领域拒绝 → 统一错误码：表单缺项 400，状态不允许 / 待联动 409，details.reason 为机读原因。 */
export function failPlan(plan: Extract<OfferPlan<unknown>, { ok: false }>): never {
  const code = plan.reason === 'OFFER_FORM_INCOMPLETE' ? 'VALIDATION_FAILED' : 'CONFLICT';
  const details = plan.fields ? { reason: plan.reason, fields: plan.fields } : { reason: plan.reason };
  throw new AppError(code, PLAN_MESSAGES[plan.reason] ?? '操作不允许', details);
}

/** 转移状态（AC-OF-08 / 09 / 17）：拒绝原因只能选启用的字典项，落库为字典里的规范编码。 */
export async function transferOffer(tx: Tx, ctx: OfferContext, id: string, input: OfferTransferInput) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  const plan = planOfferTransition(facts(before), input.target, input);
  if (!plan.ok) failPlan(plan);
  // 管理员转为已接受：超编弱控二次确认（OF-R10，候选人答复不校验）
  if (input.target === 'accepted') {
    await lockOfferSyncScope(tx, ctx, before); // 先于弱控确认取齐关联人员锁（sync-lock.ts 锁序）
    await requireQuotaConfirmed(tx, ctx, before, input.confirmed === true);
  }
  const patch = plan.patch.refusalReasonCode
    ? {
        ...plan.patch,
        refusalReasonCode: await requireEnabledOfferReason(
          tx,
          ctx.tenantId,
          'refusal-reasons',
          plan.patch.refusalReasonCode,
        ),
      }
    : plan.patch;
  // 转已拒绝 / 已发退回待发：已有待入职联动取消入职（34 §2.1、AC-OF-03），与 Offer 状态同一事务
  if (offerTransitionCancelsEntry(facts(before), input.target))
    await cancelLinkedEntry(tx, ctx, before, { code: input.refusalReasonCode, remark: input.refusalRemark });
  return save(tx, ctx, before, 'transfer', patch);
}

/** 失效（OF-R7）：确定即失效，记失效时间；不可恢复（转移候选为空、只能复制）。 */
export async function invalidateOffer(tx: Tx, ctx: OfferContext, id: string, input: OfferInvalidateInput) {
  // BE-14a3：先锁在途批量单再锁 Offer（与审批动作同序），取锁后复核关联未变；随后在同一事务里作废在途审批
  const { cancelOfferApprovals } = await import('./approval.js');
  const before = await lockOfferWithBatches(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  const plan = planOfferInvalidation(facts(before), input);
  if (!plan.ok) failPlan(plan);
  const invalidReasonCode = await requireEnabledOfferReason(
    tx,
    ctx.tenantId,
    'invalid-reasons',
    plan.patch.invalidReasonCode,
  );
  // 已有待入职：同事务删除待入职（OF-R7，不可恢复），Offer 上的关联随之解除
  const hadEntry = facts(before).hasPendingEntry;
  if (hadEntry) await deleteLinkedEntry(tx, ctx, before);
  const after = await save(tx, ctx, before, 'invalidate', {
    ...plan.patch,
    invalidReasonCode,
    invalidAt: ctx.now,
    ...(hadEntry ? { pendingEntryBusinessId: null } : {}),
  });
  // 同一事务里作废在途审批（单个实例 / 所在批量单），否则 revision 变了的审批再也办不结（#398 衔接）
  return (await cancelOfferApprovals(tx, ctx, id)) ? offerDto(await loadOffer(tx, ctx, id)) : after;
}

/** 转移状态表单：可选目标与已保存的拒绝时间 / 原因 / 备注（再次选“已拒绝”时带出原值，DEC-532①）。 */
export async function offerTransferForm(tx: Tx, ctx: OfferContext, id: string) {
  const row = await loadOffer(tx, ctx, id);
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    targets: offerTransferTargets(facts(row)),
    acceptTime: row.acceptTime,
    refusalTime: row.refusalTime,
    refusalReasonCode: row.refusalReasonCode,
    refusalRemark: row.refusalRemark,
  };
}

/** OF-R3 发送前拦截判定（发送动作在 BE-14b）：按 Offer 类型读开关，返回是否允许与机读原因。 */
export async function offerSendCheck(tx: Tx, ctx: OfferContext, id: string) {
  const row = await loadOffer(tx, ctx, id);
  const plan = planOfferSend(facts(row), (await readOfferApprovalSettings(tx, ctx.tenantId)).send);
  return {
    id: row.id,
    offerType: effectiveOfferType(typeOf(row)),
    allowed: plan.ok,
    reason: plan.ok ? null : plan.reason,
  };
}
