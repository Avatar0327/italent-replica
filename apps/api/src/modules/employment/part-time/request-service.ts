/**
 * 兼职申请的内部服务（docs/08_设计/R2-T05_兼职设计.md §2.2 / §4.3A / §4.4 / §4.5，PT-4a 底座）：新增申请的建 / 改 / 提交 /
 * 撤回 / HR 撤销 / 删除、审批通过后的落地与复核、系统作废。本批没有公开路由（PT-4b 才开）；延长 / 结束申请随 PT-4c，
 * 在此之前创建入口只有 add，其余类型的审批回调一律 409 PART_TIME_REQUEST_TYPE_NOT_AVAILABLE（见 approval-adapter）。
 * 每个人工入口都在员工行锁内重跑 D-1～D-10 与主职周期边界（A-16：草稿也不豁免，越界当次拒绝，不留越界版本）。
 * 审批中心（approval/）经动态导入调用：审批适配器 → 本文件 → 审批中心会成环，静态导入在模块装载期不安全（同 Offer）。
 */
import {
  APPROVAL_TYPES,
  PART_TIME_AUDIT_OBJECTS,
  PART_TIME_ERRORS,
  PART_TIME_NOTICE_TEMPLATES,
  PART_TIME_REMARK_MAX,
  nextPartTimeRequestState,
  type PartTimeInitiator,
  type PartTimeRequestAction,
  type PartTimeRequestState,
  type PartTimeRequestType,
  type PartTimeVoidReason,
} from '@italent/domain';
import type { Tx } from '@italent/db';
import { AppError, ERROR_STATUS } from '../../../errors.js';
import { schedulerAwareContext, type ApprovalContext, type FieldAccess } from '../../approval/context.js';
import { assertRevision, auditEmployment, requireEmployeeInScope, requireScopedEmploymentObject } from '../context.js';
import { lockEmploymentEmployee } from '../record-store.js';
import type { EmploymentContext } from '../types.js';
import {
  appendRequestState,
  appendRequestVersion,
  insertPartTimeRequest,
  loadPartTimeRequest,
  partTimeRequestOwner,
  type PartTimeRequestRow,
  type RequestPayload,
} from './request-store.js';
import { checkNewPartTime, insertCheckedPartTime, type CreatePartTimeInput } from './service.js';
import { normalizeNewPartTime, type NormalizedPartTime } from './validation.js';

export interface AddRequestInput extends CreatePartTimeInput {
  /** 发起方式：self / manager 入口由 F-020 做（DEC-200 / 283），服务层预留；缺省 hr。 */
  readonly initiator?: PartTimeInitiator;
  /** 申请备注（0/32766，原站计数器）。 */
  readonly remark?: string | null;
}

/** 修改草稿 / 驳回中的新增申请：缺省键 = 不改，显式 null 清空该字段。 */
export type AddRequestPatch = Partial<Omit<AddRequestInput, 'employeeId' | 'initiator'>>;

export interface PartTimeRequestView {
  readonly id: string;
  readonly employeeId: string;
  readonly requestType: PartTimeRequestType;
  readonly state: PartTimeRequestState;
  readonly revision: number;
  readonly initiator: PartTimeInitiator;
  readonly initiatorUserId: string;
  readonly processCode: string | null;
  readonly versionNo: number;
  readonly serviceType: string;
  readonly departmentId: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly remark: string | null;
  /** 落地成功后的兼职记录 ID。 */
  readonly recordId: string | null;
  /** B-4 等只提示不拦的信息。 */
  readonly warnings: readonly string[];
}

const notFound = () => new AppError('NOT_FOUND', '兼职申请不存在');
const typeNotAvailable = () =>
  new AppError('CONFLICT', '该类兼职申请暂未开放', { reason: PART_TIME_ERRORS.requestTypeNotAvailable });

export function requestView(
  request: PartTimeRequestRow,
  extra: { readonly recordId?: string | null; readonly warnings?: readonly string[] } = {},
): PartTimeRequestView {
  const { version } = request;
  return {
    id: request.id,
    employeeId: request.employeeId,
    requestType: request.requestType,
    state: request.state,
    revision: request.revision,
    initiator: request.initiator,
    initiatorUserId: request.initiatorUserId,
    processCode: request.processCode,
    versionNo: version.versionNo,
    serviceType: version.serviceType,
    departmentId: version.departmentId,
    startDate: version.startDate,
    endDate: version.endDate,
    remark: version.remark,
    recordId: extra.recordId ?? null,
    warnings: extra.warnings ?? [],
  };
}

/** 审计快照：状态 + 本单内容（非空预置字段、日期、备注、自定义字段），只放字段值。 */
function snapshotOf(request: PartTimeRequestRow): Record<string, unknown> {
  const { version } = request;
  const preset = {
    departmentId: version.departmentId,
    positionId: version.positionId,
    postId: version.postId,
    sequenceId: version.sequenceId,
    levelId: version.levelId,
    directManagerId: version.directManagerId,
    dottedManagerId: version.dottedManagerId,
    employmentType: version.employmentType,
    employmentForm: version.employmentForm,
  };
  return {
    state: request.state,
    requestType: request.requestType,
    serviceType: version.serviceType,
    startDate: version.startDate,
    endDate: version.endDate,
    remark: version.remark,
    ...Object.fromEntries(Object.entries(preset).filter(([, value]) => value !== null)),
    ...Object.fromEntries(Object.entries(version.customFields).map(([id, value]) => [`custom:${id}`, value])),
  };
}

/** 兼职申请审计（§7.4）：归属 = 员工 + 申请部门（add 取最新版本部门），写在业务同一事务。 */
export function auditRequest(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  request: PartTimeRequestRow,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  meta?: Readonly<Record<string, unknown>>,
) {
  return auditEmployment(tx, ctx, action, PART_TIME_AUDIT_OBJECTS.request, request.id, before, after, undefined, meta, {
    employeeId: request.employeeId,
    orgId: request.version.departmentId,
  });
}

/** 同一状态迁移的前后快照（只含 state），状态类动作的审计共用。 */
const stateChange = (before: PartTimeRequestRow, after: PartTimeRequestRow, extra: Record<string, unknown> = {}) =>
  [{ state: before.state }, { state: after.state, ...extra }] as const;

/** 载荷 → 新增兼职入参（修改 / 提交 / 落地复核都从申请最新版本重建，保证校验口径一致）。 */
function inputOf(request: PartTimeRequestRow): CreatePartTimeInput {
  const { version } = request;
  return {
    employeeId: request.employeeId,
    serviceType: version.serviceType,
    startDate: version.startDate,
    endDate: version.endDate,
    departmentId: version.departmentId ?? '',
    positionId: version.positionId,
    postId: version.postId,
    levelId: version.levelId,
    sequenceId: version.sequenceId,
    directManagerId: version.directManagerId,
    dottedManagerId: version.dottedManagerId,
    employmentForm: version.employmentForm,
    employmentType: version.employmentType,
    customFields: version.customFields,
  };
}

function assertRemark(remark: string | null | undefined): string | null {
  if (remark == null) return null;
  if (typeof remark !== 'string' || remark.length > PART_TIME_REMARK_MAX)
    throw new AppError('VALIDATION_FAILED', `申请备注不能超过 ${PART_TIME_REMARK_MAX} 个字符`, {
      field: 'requestRemark',
    });
  return remark;
}

function payloadOf(
  normalized: NormalizedPartTime,
  customFields: RequestPayload['customFields'],
  remark: string | null,
): RequestPayload {
  const { fields } = normalized;
  return {
    serviceType: normalized.serviceType,
    departmentId: normalized.departmentId,
    positionId: fields.positionId,
    postId: fields.postId,
    sequenceId: fields.sequenceId,
    levelId: fields.levelId,
    directManagerId: fields.directManagerId,
    dottedManagerId: fields.dottedManagerId,
    employmentType: fields.employmentType,
    employmentForm: fields.employmentForm,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    originalEndDate: null,
    baseTermNo: null,
    remark,
    customFields,
  };
}

/** 先锁员工行再锁申请头（§7.1）；返回锁内读到的申请。 */
export async function lockPartTimeRequest(tx: Tx, ctx: EmploymentContext, requestId: string) {
  const owner = await partTimeRequestOwner(tx, ctx.tenantId, requestId);
  if (!owner) throw notFound();
  const employee = await lockEmploymentEmployee(tx, ctx, owner.employeeId);
  const request = await loadPartTimeRequest(tx, ctx.tenantId, requestId, true);
  if (!request) throw notFound();
  return { employee, request };
}

/** 数据范围（§7.2）：员工按主职在范围，申请部门在范围；“使用用户”维度的创建人是申请发起人。范围外与不存在同一个 404。 */
async function requireRequestScope(tx: Tx, ctx: EmploymentContext, request: PartTimeRequestRow) {
  await requireEmployeeInScope(tx, ctx, request.employeeId);
  await requireScopedEmploymentObject(
    tx,
    { ...ctx, userId: request.initiatorUserId },
    request.employeeId,
    request.version.departmentId,
  );
}

function assertAction(request: PartTimeRequestRow, action: PartTimeRequestAction): PartTimeRequestState {
  const next = nextPartTimeRequestState(request.state, action);
  if (!next)
    throw new AppError('CONFLICT', '当前状态不能执行该操作', {
      reason: PART_TIME_ERRORS.requestStateInvalid,
      state: request.state,
      action,
    });
  return next;
}

function assertAdd(request: PartTimeRequestRow) {
  if (request.requestType !== 'add') throw typeNotAvailable();
}

/** 提交（含驳回后重提）只允许原发起人（DEC-113）；当前权限复核在路由层（PT-4b）。 */
function assertInitiator(request: PartTimeRequestRow, ctx: EmploymentContext) {
  if (request.initiatorUserId !== ctx.userId)
    throw new AppError('FORBIDDEN', '只有原发起人可以操作该兼职申请', { reason: PART_TIME_ERRORS.notInitiator });
}

/** 建新增兼职申请草稿：D-1～D-10 + 周期边界 + 外派 / 借调唯一，通过才写；越界当次拒绝，不建申请头、无审计（PB-63）。 */
export async function createAddRequest(
  tx: Tx,
  ctx: EmploymentContext,
  input: AddRequestInput,
): Promise<PartTimeRequestView> {
  const normalized = normalizeNewPartTime(input);
  const remark = assertRemark(input.remark);
  const employee = await lockEmploymentEmployee(tx, ctx, normalized.employeeId);
  await requireEmployeeInScope(tx, ctx, employee.id);
  await requireScopedEmploymentObject(tx, ctx, employee.id, normalized.departmentId);
  const checked = await checkNewPartTime(tx, ctx, employee, normalized);
  const request = await insertPartTimeRequest(
    tx,
    ctx,
    {
      employeeId: employee.id,
      requestType: 'add',
      recordId: null,
      initiator: input.initiator ?? 'hr',
      processCode: APPROVAL_TYPES.part_time_add.defaultProcessCode,
    },
    payloadOf(normalized, checked.custom.customFields, remark),
  );
  await auditRequest(tx, ctx, 'part_time.request.create', request, null, snapshotOf(request));
  return requestView(request, { warnings: checked.warnings });
}

/** 把修改合入最新版本，得到完整入参（显式给出的键覆盖，含显式 null）。 */
function mergePatch(
  request: PartTimeRequestRow,
  patch: AddRequestPatch,
): CreatePartTimeInput & { remark?: string | null } {
  const base = inputOf(request);
  const merged: Record<string, unknown> = { ...base, remark: request.version.remark };
  for (const [key, value] of Object.entries(patch))
    merged[key] = key === 'customFields' ? { ...base.customFields, ...(value as object) } : value;
  return merged as unknown as CreatePartTimeInput & { remark?: string | null };
}

/**
 * 合入改动 → 整体重校验 → 通过才追加载荷版本（修改草稿与审批编辑共用；校验失败不追加，A-16 / PB-63 / PB-82）。
 * 调用方已持有员工行与申请头锁，并判过状态与数据范围。
 */
async function rewriteVersion(
  tx: Tx,
  ctx: EmploymentContext,
  employee: { readonly id: string; readonly code: string },
  request: PartTimeRequestRow,
  patch: AddRequestPatch,
  meta?: Readonly<Record<string, unknown>>,
): Promise<PartTimeRequestView> {
  const merged = mergePatch(request, patch);
  const normalized = normalizeNewPartTime(merged);
  const remark = assertRemark(merged.remark);
  if (normalized.departmentId !== request.version.departmentId)
    await requireScopedEmploymentObject(tx, ctx, employee.id, normalized.departmentId);
  const checked = await checkNewPartTime(tx, ctx, employee, normalized, request.id);
  const updated = await appendRequestVersion(
    tx,
    ctx,
    request,
    payloadOf(normalized, checked.custom.customFields, remark),
  );
  await auditRequest(tx, ctx, 'part_time.request.update', updated, snapshotOf(request), snapshotOf(updated), meta);
  return requestView(updated, { warnings: checked.warnings });
}

/**
 * 修改草稿 / 驳回中的新增申请（审批中不能直接改，要改走审批编辑或先撤回）。驳回中的申请修改后仍是驳回态，
 * 重提时再按最新版本复核一次。
 */
export async function updateAddRequest(
  tx: Tx,
  ctx: EmploymentContext,
  requestId: string,
  patch: AddRequestPatch,
): Promise<PartTimeRequestView> {
  const { employee, request } = await lockPartTimeRequest(tx, ctx, requestId);
  assertAdd(request);
  assertRevision(ctx.expectedRevision, request.revision);
  assertAction(request, 'submit');
  await requireRequestScope(tx, ctx, request);
  return rewriteVersion(tx, ctx, employee, request, patch);
}

/**
 * 审批编辑（适配器 edit，独立编辑与编辑并同意共用，§4.3A 末）：先合入改动得到待写版本，按新增申请重跑 D-1～D-10 与周期边界，
 * 通过才追加版本；不通过抛业务错误，由审批事务整体回滚（任务、实例、申请都不变）。审批人只操作本单，不走 HR 员工范围（DEC-057）。
 */
export async function editRequestInApproval(
  tx: Tx,
  ctx: EmploymentContext,
  requestId: string,
  patch: AddRequestPatch,
): Promise<void> {
  const { employee, request } = await lockPartTimeRequest(tx, ctx, requestId);
  assertAdd(request);
  if (request.state !== 'in_review') assertAction(request, 'withdraw');
  await rewriteVersion(tx, ctx, employee, request, patch, { approvalEdit: true });
}

/** 审批侧结论回写（驳回 / 不同意 / 审批侧撤回）：只处理仍在审批中的申请，重复回调不重复写。 */
export async function settleRequestFromApproval(
  tx: Tx,
  ctx: EmploymentContext,
  requestId: string,
  action: 'reject' | 'disapprove' | 'withdraw',
): Promise<void> {
  const { request } = await lockPartTimeRequest(tx, ctx, requestId);
  if (request.state !== 'in_review') return;
  const next = await appendRequestState(tx, ctx, request, assertAction(request, action));
  const audited = { reject: 'rejected', disapprove: 'disapproved', withdraw: 'withdraw' }[action];
  await auditRequest(tx, ctx, `part_time.request.${audited}`, next, ...stateChange(request, next));
}

const approvalContext = (ctx: EmploymentContext, fields?: FieldAccess): ApprovalContext =>
  ({ ...ctx, expectedRevision: 0, ...(fields ? { fields } : {}) }) as ApprovalContext;

/**
 * 提交（含驳回后重提）：只允许原发起人，按最新版本重跑 D-1～D-10 与周期边界，写 in_review 后交审批中心匹配流程并派首节点；
 * 没有匹配的流程、首节点无审批人等拒绝时整单回滚，申请保持原状态（DEC-017 / DEC-054）。驳回后的重提沿用原实例（DEC-103）。
 */
export async function submitRequest(
  tx: Tx,
  ctx: EmploymentContext,
  requestId: string,
  fields?: FieldAccess,
): Promise<PartTimeRequestView> {
  const { employee, request } = await lockPartTimeRequest(tx, ctx, requestId);
  assertAdd(request);
  assertRevision(ctx.expectedRevision, request.revision);
  assertAction(request, 'submit');
  assertInitiator(request, ctx);
  await requireRequestScope(tx, ctx, request);
  const checked = await checkNewPartTime(tx, ctx, employee, normalizeNewPartTime(inputOf(request)), request.id);
  const submitted = await appendRequestState(tx, ctx, request, 'in_review');
  await auditRequest(tx, ctx, 'part_time.request.submit', submitted, ...stateChange(request, submitted));
  const { startOrResume } = await import('../../approval/engine.js');
  await startOrResume(tx, approvalContext(ctx, fields), { businessType: 'part_time', businessId: request.id });
  const settled = (await loadPartTimeRequest(tx, ctx.tenantId, request.id))!;
  return requestView(settled, { warnings: checked.warnings });
}

/** 发起人撤回：审批中 → 草稿，结束在途实例（AC-TRF-28）。 */
export async function withdrawRequest(tx: Tx, ctx: EmploymentContext, requestId: string): Promise<PartTimeRequestView> {
  const { request } = await lockPartTimeRequest(tx, ctx, requestId);
  assertRevision(ctx.expectedRevision, request.revision);
  const next = assertAction(request, 'withdraw');
  assertInitiator(request, ctx);
  await requireRequestScope(tx, ctx, request);
  const withdrawn = await appendRequestState(tx, ctx, request, next);
  await auditRequest(tx, ctx, 'part_time.request.withdraw', withdrawn, ...stateChange(request, withdrawn));
  const { activeInstanceOf } = await import('../../approval/store.js');
  const { withdraw } = await import('../../approval/actions.js');
  const active = await activeInstanceOf(tx, ctx.tenantId, 'part_time', request.id);
  if (active) await withdraw(tx, approvalContext(ctx), active.id, true);
  return requestView(withdrawn);
}

/** HR 撤销未办结的申请：作废（reason = hr），不生成兼职，作废是终态，实例一并取消。 */
export async function revokeRequest(tx: Tx, ctx: EmploymentContext, requestId: string): Promise<PartTimeRequestView> {
  const { request } = await lockPartTimeRequest(tx, ctx, requestId);
  assertRevision(ctx.expectedRevision, request.revision);
  assertAction(request, 'revoke');
  await requireRequestScope(tx, ctx, request);
  const voided = await voidPartTimeRequest(tx, ctx, request, { reason: 'hr', action: 'part_time.request.revoke' });
  return requestView(voided);
}

/** 删除草稿 / 驳回中的申请（保留快照，状态置 deleted）；驳回中的实例一并取消。 */
export async function deleteRequest(tx: Tx, ctx: EmploymentContext, requestId: string): Promise<PartTimeRequestView> {
  const { request } = await lockPartTimeRequest(tx, ctx, requestId);
  assertRevision(ctx.expectedRevision, request.revision);
  const next = assertAction(request, 'delete');
  await requireRequestScope(tx, ctx, request);
  const deleted = await appendRequestState(tx, ctx, request, next);
  await auditRequest(tx, ctx, 'part_time.request.delete', deleted, snapshotOf(request), null);
  const { activeInstanceOf } = await import('../../approval/store.js');
  const { cancel } = await import('../../approval/actions.js');
  const active = await activeInstanceOf(tx, ctx.tenantId, 'part_time', request.id);
  if (active) await cancel(tx, approvalContext(ctx), active.id);
  return requestView(deleted);
}

export interface VoidOptions {
  readonly reason: PartTimeVoidReason;
  /** 审计动作（§7.4）：part_time.request.revoke / voided / voided_by_exit / voided_by_transfer。 */
  readonly action: string;
  /** 站内消息模板；缺省不发。接收人 = 发起人（离职另含被申请人本人，同 R2-T03 §5.5）。 */
  readonly template?: string;
  /** 落地复核失败的作废发生在审批动作内，实例正在办结，不再取消。 */
  readonly keepInstance?: boolean;
}

/**
 * 作废一张未办结 / 已批未落地的申请（HR 撤销、离职、调动、落地复核失败共用的单一入口）：状态置 voided（必带原因）→
 * 审批实例 cancel（走 approval/actions cancel，关闭待办）→ 审计 + outbox → 站内消息（没有实例的草稿只留 outbox，A-7）。
 * 调用方已持有员工行锁与申请头锁。
 */
export async function voidPartTimeRequest(
  tx: Tx,
  ctx: EmploymentContext,
  request: PartTimeRequestRow,
  options: VoidOptions,
): Promise<PartTimeRequestRow> {
  const next = assertAction(request, 'void');
  const { activeInstanceOf, latestInstanceOf } = await import('../../approval/store.js');
  const { cancel } = await import('../../approval/actions.js');
  const approvalCtx = schedulerAwareContext(approvalContext(ctx));
  const active = options.keepInstance ? null : await activeInstanceOf(tx, ctx.tenantId, 'part_time', request.id);
  const instance = active ?? (await latestInstanceOf(tx, ctx.tenantId, 'part_time', request.id));
  const voided = await appendRequestState(tx, ctx, request, next, { reason: options.reason });
  if (active) await cancel(tx, approvalCtx, active.id);
  await auditRequest(tx, ctx, options.action, voided, ...stateChange(request, voided, { reason: options.reason }));
  if (options.template && instance) {
    const { notifyMessage } = await import('../../approval/notifications.js');
    const { userOfPerson } = await import('../../approval/resolver.js');
    const applicant = options.reason === 'exit' ? await userOfPerson(tx, ctx.tenantId, request.employeeId) : null;
    for (const recipientUserId of new Set([request.initiatorUserId, applicant].filter((id): id is string => !!id)))
      await notifyMessage(tx, approvalCtx, instance, {
        recipientUserId,
        templateCode: options.template,
      });
  }
  return voided;
}

/** 落地复核失败的业务拒绝（400 / 404 / 409 类）：作废，不让审批动作失败；存储错误（5xx）照常抛。 */
function isLandingRejection(error: unknown): error is AppError {
  return error instanceof AppError && ERROR_STATUS[error.code] < 500;
}

/**
 * 审批末节点同意后的落地（审批适配器 approved 回调，同一事务；§4.4）：先写 approved，再复核并落地。复核通过 → 建兼职记录 +
 * 第 1 期（source = create、source_id = 申请 ID）并写 effective；任一业务校验不通过 → 写 voided（landing_rejected）、
 * 审计、通知发起人，审批结论保留（F-007 §2-3 同一落点）。重复回调（已不是审批中）不重复落地。
 */
export async function landApprovedRequest(tx: Tx, ctx: EmploymentContext, requestId: string): Promise<void> {
  const { employee, request } = await lockPartTimeRequest(tx, ctx, requestId);
  if (request.state !== 'in_review') return;
  assertAdd(request);
  const approved = await appendRequestState(tx, ctx, request, assertAction(request, 'approve'));
  await auditRequest(tx, ctx, 'part_time.request.approved', approved, ...stateChange(request, approved));
  try {
    const normalized = normalizeNewPartTime(inputOf(approved));
    const checked = await checkNewPartTime(tx, ctx, employee, normalized, approved.id);
    const record = await insertCheckedPartTime(tx, ctx, employee.id, normalized, checked, { sourceId: approved.id });
    const landed = await appendRequestState(tx, ctx, approved, assertAction(approved, 'land'), { recordId: record.id });
    await auditRequest(
      tx,
      ctx,
      'part_time.request.effective',
      landed,
      ...stateChange(approved, landed, { recordId: record.id }),
    );
  } catch (error) {
    if (!isLandingRejection(error)) throw error;
    await voidPartTimeRequest(tx, ctx, approved, {
      reason: 'landing_rejected',
      action: 'part_time.request.voided',
      template: PART_TIME_NOTICE_TEMPLATES.voided,
      keepInstance: true,
    });
  }
}
