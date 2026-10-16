/**
 * 离职写入口公共门禁（R2-T03 §4A）：kind=leave / retirement 所有公开入口的唯一前置条件实现。
 * 顺序固定：功能操作权 + 按钮权 + 字段权（复用 context.ts requireEmploymentWrite，不以 Employment.Create / Edit / Delete
 * 代替 Dimission* 四个按钮）→ 范围由调用方入口先验（readContext / authorizeBusinessWrite）→ 本文件的前置条件：
 * 日期创建后不可改（§7.2，DEC-499）、同员工无未办结离职、字典启用、§8A 逾期迟到调动、§8B 转正在途、§8 在途调动确认令牌、
 * §18.1 关口 ④⑤ 与撤销。所有拒绝发生在首个写之前（调用方在命令事务内先调用本门禁）。
 * 退休（R2-T04）只受日期规则约束；没有扩展行的离职（可信造数）保持 main 行为。
 */
import { createHmac } from 'node:crypto';
import { and, eq, exitRequests, sql, type Tx } from '@italent/db';
import { buttonResource, EXIT_BUTTONS } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { findOverdueTransfers } from './activation-store.js';
import { EMPLOYMENT_OBJECT, employmentCreator, requireEmploymentWrite } from './context.js';
import { currentEmploymentCycle } from './cycles.js';
import { assertExitDictionaryEnabled } from './exit-dictionaries.js';
import type { ExitOptions } from './exit-initiation.js';
import { rowsOf } from './record-store.js';
import { plannedEffectiveDate } from './timeline.js';
import type { LockedEmploymentBusiness } from './record-store.js';
import type { BusinessKind, EmploymentBusinessPatch, EmploymentContext } from './types.js';
import { visibleEmploymentRecords } from './visibility.js';

export type ExitOperation = 'preview' | 'create' | 'submit' | 'update' | 'withdraw' | 'cancel' | 'retry';
/** createEmploymentBusiness 只认经过本门禁的离职创建（exit-application.ts 持有）；可信造数走 ctx.trustedExit。 */
export const EXIT_GATE_PASS = Object.freeze({ passedExitGate: true });
export const isExitKind = (kind: BusinessKind) => kind === 'leave' || kind === 'retirement';

const BUTTON = { ...EXIT_BUTTONS, retry: 'Employment.RetryActivation' } as const;

/** 创建 / 提交时确认过的在途调动集合与令牌哈希（写入 exit_requests.pending_transfer_ack，不回传，§8）。 */
export interface AckRecord {
  readonly ids: readonly string[];
  readonly hash: string;
}

export interface ExitGateTarget {
  readonly employeeId: string;
  readonly kind?: BusinessKind;
  /** 发起方式；自助 / 经理代发的入口按钮归 F-020，不在本门禁复核 HR 按钮。 */
  readonly initiation?: 'hr' | 'self' | 'manager';
  readonly mode?: 'application' | 'direct';
  readonly lastWorkDate?: string;
  /** 创建时写入的任职载荷（字段权限按键校验）。 */
  readonly payload?: object;
  readonly exit?: ExitOptions;
  readonly business?: LockedEmploymentBusiness;
  readonly patch?: EmploymentBusinessPatch;
  /** cancel：通用 DELETE（object.delete）还是 revoke（object.update）。 */
  readonly deleting?: boolean;
  /** 离职扩展行（门禁内部加载；submit / withdraw 按发起方式取按钮）。 */
  readonly row?: typeof exitRequests.$inferSelect;
  /** 审批编辑 / 编辑并同意：权限由审批中心按节点规则负责，本门禁只判日期。 */
  readonly approvalEdit?: boolean;
}

export interface ExitGateResult {
  readonly ack: AckRecord | null;
}

const conflict = (reason: string, message: string, details: object = {}) =>
  new AppError('CONFLICT', message, { reason, ...details });

export async function loadExitRequest(tx: Tx, tenantId: string, businessId: string) {
  // 升级验收（AC-EV-leave-upgrade、AC-APV-F048-upgrade-types）在迁移 0132 之前的结构上跑离职流转：没有扩展表按“没有扩展行”处理
  const [probe] = rowsOf<{ present: boolean }>(
    await tx.execute(sql`SELECT to_regclass('public.exit_requests') IS NOT NULL AS present`),
  );
  if (!probe?.present) return undefined;
  const [row] = await tx
    .select()
    .from(exitRequests)
    .where(and(eq(exitRequests.tenantId, tenantId), eq(exitRequests.businessId, businessId)));
  return row;
}

// ---- 权限链 ----------------------------------------------------------------------------------------------

const detailButton = (ctx: EmploymentContext, code: string) =>
  requirePermission(ctx.authorize!, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail'),
  });

const EXIT_CONTROL_KEYS = ['dutyTransfer', 'pendingTransferAck'];
const createPayload = (target: ExitGateTarget) => ({
  kind: target.kind ?? 'leave',
  mode: target.mode,
  lastWorkDate: target.lastWorkDate,
  ...Object.fromEntries(
    Object.entries(target.exit ?? {}).filter(([key, value]) => value !== undefined && !EXIT_CONTROL_KEYS.includes(key)),
  ),
  ...(target.payload ?? {}),
});

/** 功能权 + 按钮权 + 字段权；可信上下文（无授权器）直接放行。范围由入口层先验。 */
export async function requireExitPermission(ctx: EmploymentContext, operation: ExitOperation, target: ExitGateTarget) {
  if (!ctx.authorize || target.approvalEdit) return;
  const command = { commandOnly: true };
  switch (operation) {
    case 'preview':
      await detailButton(ctx, BUTTON.direct).catch(() => detailButton(ctx, BUTTON.application));
      return;
    case 'create':
      if (target.initiation && target.initiation !== 'hr') return;
      await requireEmploymentWrite(
        ctx,
        'create',
        createPayload(target),
        target.mode === 'direct' ? BUTTON.direct : BUTTON.application,
      );
      return;
    case 'update':
      await requireEmploymentWrite(ctx, 'update', { ...target.patch, ...target.payload }, BUTTON.edit);
      return;
    case 'submit':
    case 'withdraw':
      // 自助 / 经理代发的发起人按钮归 F-020（暂名 Portal.ExitApply / Team.ExitApply）；HR 单据复核 DimissionApproval
      if (!target.row || target.row.initiator === 'hr')
        await requireEmploymentWrite(ctx, 'update', {}, BUTTON.application, undefined, command);
      return;
    case 'cancel':
      await requireEmploymentWrite(ctx, target.deleting ? 'delete' : 'update', {}, BUTTON.cancel, undefined, command);
      return;
    case 'retry':
      await requireEmploymentWrite(ctx, 'update', {}, BUTTON.retry, undefined, command);
      await detailButton(ctx, BUTTON.direct);
  }
}

// ---- §7.2 日期创建后不可改 ---------------------------------------------------------------------------------

/** 请求里的最后工作日 / 生效日与当前最新载荷不同 → 400，且在任何写入之前（审批编辑、编辑并同意同路）。 */
export function assertExitDatesUnchanged(business: LockedEmploymentBusiness, patch: EmploymentBusinessPatch): void {
  const { payload } = business;
  const changed =
    (patch.lastWorkDate !== undefined && patch.lastWorkDate !== payload.lastWorkDate) ||
    (patch.effectiveDate !== undefined && patch.effectiveDate !== payload.effectiveDate);
  if (changed)
    throw new AppError('VALIDATION_FAILED', '离职最后工作日只在创建时填写，创建后不能修改；如需调整请撤销后重新办理', {
      reason: 'EXIT_DATE_IMMUTABLE',
    });
}

// ---- 在途申请清单与披露（§8 / §8A / §8B）-------------------------------------------------------------------

interface InFlight {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly planned: string;
  readonly departmentId: string | null;
  readonly landed: boolean;
}

/** 员工名下指定类型的未办结申请（最新载荷 + 最新状态；计划生效日只取 §5.0A）。 */
async function inFlightApplications(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  kinds: readonly string[],
  states: readonly string[],
  mode: 'application' | null = 'application',
): Promise<InFlight[]> {
  const planned = plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`);
  return rowsOf<InFlight>(
    await tx.execute(sql`
      SELECT b.id, p.kind, s.state, ${planned}::text AS planned, p.department_id AS "departmentId",
        EXISTS (SELECT 1 FROM employment_records r WHERE r.tenant_id=b.tenant_id AND r.id=b.id) AS landed
      FROM employment_business_objects b
      JOIN LATERAL (SELECT * FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
        AND (${mode}::text IS NULL OR p.mode=${mode}::text)
        AND p.kind = ANY(${`{${kinds.join(',')}}`}::text[]) AND s.state = ANY(${`{${states.join(',')}}`}::text[])
      ORDER BY planned, b.id LIMIT 1001`),
  );
}

interface Disclosable {
  readonly id: string;
  readonly effectiveDate: string;
  readonly departmentId: string | null;
  readonly extra?: object;
}

/**
 * 披露：逐项按 DEC-177 可见性 + 字段查看权裁剪，不可见的只计件数 hiddenCount（响应的每一层都按字段权限裁剪）。
 * 返回形态固定为 { items, hiddenCount }，items 只含 businessId / effectiveDate（及调用方附加的 extra）。
 */
async function disclose(tx: Tx, ctx: EmploymentContext, employeeId: string, rows: readonly Disclosable[]) {
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '在途申请过多，请先处理');
  const creators = new Map<string, string | null>();
  if (ctx.scope?.terms?.some((term) => term.dimension === 'using_user') && rows.length) {
    const list = `{${rows.map((row) => row.id).join(',')}}`;
    const found = rowsOf<{ id: string; creator: string | null }>(
      await tx.execute(sql`SELECT t.id::text AS id, ${employmentCreator(ctx.tenantId, sql`t.id`, true)} AS creator
        FROM unnest(${list}::uuid[]) AS t(id)`),
    );
    for (const row of found) creators.set(row.id, row.creator);
  }
  const visible = await visibleEmploymentRecords(
    tx,
    ctx.tenantId,
    ctx.scope,
    rows.map((row) => ({ employeeId, departmentId: row.departmentId, creatorId: creators.get(row.id) ?? null })),
  );
  const viewable = ctx.authorize
    ? await getModuleViewableFieldsInTransaction(
        { authorize: ctx.authorize, clock: () => ctx.now },
        ctx,
        EMPLOYMENT_OBJECT,
        tx,
      )
    : undefined;
  const may = (field: string) => viewable === undefined || viewable.has(field);
  const shown = rows.filter((_, index) => visible[index] && may('id'));
  return {
    items: shown.map((row) => ({
      businessId: row.id,
      ...(may('effectiveDate') ? { effectiveDate: row.effectiveDate } : {}),
      ...row.extra,
    })),
    hiddenCount: rows.length - shown.length,
  };
}

/** §8A：逾期迟到调动（A 未落地申请 / B 已落地联动未完成）→ 409 EXIT_LATE_TRANSFER_PENDING。 */
async function assertNoOverdueTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const { blocking } = await findOverdueTransfers(tx, ctx, employeeId);
  if (!blocking.length) return;
  throw conflict(
    'EXIT_LATE_TRANSFER_PENDING',
    '存在已过计划生效日仍未执行的调动，请先处理',
    await disclose(
      tx,
      ctx,
      employeeId,
      blocking.map((item) => ({ ...item, extra: { materialized: item.materialized } })),
    ),
  );
}

/** 租户里按业务类型登记的“转正”任职类型（劳务转正式随 R2-T07 / BE-6 加入时自动纳入）。 */
export const REGULARIZATION_KINDS = ['intern_regularization', 'labor_regularization'] as const;

/** §8B：审批中、计划生效日 ≤ 最后工作日的劳务转正式 / 实习转正 → 409 EXIT_REGULARIZATION_IN_FLIGHT。 */
async function assertNoRegularizationInFlight(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
) {
  const rows = (await inFlightApplications(tx, ctx, employeeId, REGULARIZATION_KINDS, ['in_review'])).filter(
    (row) => row.planned <= lastWorkDate,
  );
  if (!rows.length) return;
  throw conflict(
    'EXIT_REGULARIZATION_IN_FLIGHT',
    '存在审批中的转正流程，请先处理',
    await disclose(
      tx,
      ctx,
      employeeId,
      rows.map((row) => ({ id: row.id, effectiveDate: row.planned, departmentId: row.departmentId })),
    ),
  );
}

// ---- §8 在途调动确认令牌 -----------------------------------------------------------------------------------

/**
 * 令牌 = HMAC(租户, 员工, L, 排序后的集合)。密钥取 EXIT_ACK_TOKEN_KEY；未配置时用固定标签：令牌只证明“确认的是这份集合”，
 * 集合里的业务 ID 是随机 UUID，看不到的项无法被猜出，所以不依赖密钥保密。
 */
function ackToken(ctx: EmploymentContext, employeeId: string, lastWorkDate: string, ids: readonly string[]) {
  const key = process.env.EXIT_ACK_TOKEN_KEY || 'italent-exit-pending-transfer-ack';
  return createHmac('sha256', key)
    .update(JSON.stringify([ctx.tenantId, employeeId, lastWorkDate, ids]))
    .digest('hex');
}

/**
 * 确认清单 S = 审批中的调动（不论生效日，DEC-166）∪ 已批准未落地且计划生效日 > L 的调动（DEC-220，按 §5.0A 计划日比较）。
 * 集合为空无需确认（返回 null）；非空时令牌与已存哈希 / 请求带的令牌之一一致才算确认，否则 409 并给出新令牌。
 */
async function checkPendingTransferAck(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  provided: string | undefined,
  stored: AckRecord | null,
): Promise<AckRecord | null> {
  const rows = (await inFlightApplications(tx, ctx, employeeId, ['transfer'], ['in_review', 'approved'])).filter(
    (row) => row.state === 'in_review' || (!row.landed && row.planned > lastWorkDate),
  );
  if (!rows.length) return null;
  const ids = rows.map((row) => row.id).sort();
  const hash = ackToken(ctx, employeeId, lastWorkDate, ids);
  if (provided === hash || stored?.hash === hash) return { ids, hash };
  throw conflict('EXIT_PENDING_TRANSFER_ACK_REQUIRED', '离职生效时将作废以下调动申请，请确认', {
    ackToken: hash,
    ...(await disclose(
      tx,
      ctx,
      employeeId,
      rows.map((row) => ({ id: row.id, effectiveDate: row.planned, departmentId: row.departmentId })),
    )),
  });
}

export async function saveAck(tx: Tx, ctx: EmploymentContext, businessId: string, ack: AckRecord) {
  await tx
    .update(exitRequests)
    .set({ pendingTransferAck: ack })
    .where(and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, businessId)));
}

// ---- 各操作的前置条件 --------------------------------------------------------------------------------------

/**
 * 交接人：必须是本租户且当前范围可见的员工；不存在与范围外统一 400，外键错误不能变成 500、也不暴露存在性。
 * 只存值，交接流程归 BE-8。
 */
export async function assertHandoverEmployee(tx: Tx, ctx: EmploymentContext, employeeId: string | undefined) {
  if (!employeeId) return;
  // “使用用户”范围按员工对象的真实创建者判断（与 readContext 对员工详情的口径一致），不能只传部门 / 员工
  const [row] = ctx.scope?.terms?.some((term) => term.dimension === 'using_user')
    ? rowsOf<{ creator: string | null }>(
        await tx.execute(sql`SELECT ${employmentCreator(ctx.tenantId, sql`${employeeId}::uuid`)} AS creator`),
      )
    : [];
  const [visible] = await visibleEmploymentRecords(tx, ctx.tenantId, ctx.scope, [
    { employeeId, departmentId: null, creatorId: row?.creator ?? null },
  ]);
  if (!visible) throw new AppError('VALIDATION_FAILED', '交接人不存在', { reason: 'EXIT_HANDOVER_EMPLOYEE_INVALID' });
}

async function assertDictionaries(tx: Tx, ctx: EmploymentContext, exit: ExitOptions) {
  await assertHandoverEmployee(tx, ctx, exit.handoverEmployeeId);
  if (exit.reasonCode) await assertExitDictionaryEnabled(tx, ctx.tenantId, 'reasons', exit.reasonCode);
  if (exit.whereaboutsCode) await assertExitDictionaryEnabled(tx, ctx.tenantId, 'whereabouts', exit.whereaboutsCode);
  if (exit.exitTypeCode) await assertExitDictionaryEnabled(tx, ctx.tenantId, 'types', exit.exitTypeCode);
}

/** 同员工无未办结离职：调用方须已持员工行锁（并发的两笔申请在锁后重读，恰一笔成功）。 */
async function assertNoLeaveInProgress(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const rows = await inFlightApplications(
    tx,
    ctx,
    employeeId,
    ['leave'],
    ['draft', 'in_review', 'approved', 'rejected'],
    null,
  );
  if (rows.length) throw conflict('EXIT_IN_PROGRESS', '该员工已有未办结的离职');
}

async function createConditions(tx: Tx, ctx: EmploymentContext, target: ExitGateTarget): Promise<AckRecord | null> {
  const exit = target.exit ?? {};
  const lastWorkDate = target.lastWorkDate!;
  if (exit.dutyTransfer !== undefined)
    throw new AppError('VALIDATION_FAILED', '职责转交暂不可用', { reason: 'EXIT_DUTY_TRANSFER_NOT_AVAILABLE' });
  await assertDictionaries(tx, ctx, exit);
  const cycle = await currentEmploymentCycle(tx, ctx, target.employeeId);
  if (cycle && lastWorkDate < cycle.entryDate)
    throw new AppError('VALIDATION_FAILED', `最后工作日不能早于入职生效日期（${cycle.entryDate}）`, {
      reason: 'EXIT_LAST_WORK_DATE_BEFORE_ENTRY',
      entryDate: cycle.entryDate,
    });
  await assertNoLeaveInProgress(tx, ctx, target.employeeId);
  await assertNoOverdueTransfer(tx, ctx, target.employeeId);
  await assertNoRegularizationInFlight(tx, ctx, target.employeeId, lastWorkDate);
  return checkPendingTransferAck(tx, ctx, target.employeeId, lastWorkDate, exit.pendingTransferAck, null);
}

async function submitConditions(
  tx: Tx,
  ctx: EmploymentContext,
  target: ExitGateTarget,
  provided: string | undefined,
): Promise<AckRecord | null> {
  const business = target.business!;
  const row = await loadExitRequest(tx, ctx.tenantId, business.id);
  if (!row) return null;
  // DEC-113：撤回 / 驳回后重提只允许原发起人，且重提时重新复核当前权限与关系（入口层先验，这里验发起人）
  if (row.initiatorUserId !== ctx.userId)
    throw new AppError('FORBIDDEN', '只有原发起人可以提交该离职申请', { reason: 'EXIT_SUBMIT_INITIATOR_ONLY' });
  const lastWorkDate = business.payload.lastWorkDate!;
  await assertNoOverdueTransfer(tx, ctx, business.employeeId);
  await assertNoRegularizationInFlight(tx, ctx, business.employeeId, lastWorkDate);
  const stored = (row.pendingTransferAck ?? null) as AckRecord | null;
  return checkPendingTransferAck(tx, ctx, business.employeeId, lastWorkDate, provided, stored);
}

/** 撤销在 B4 前对 approved / effective 离职不提供（§18.1），不存在绕过 §6B 的删除路径。 */
async function cancelConditions(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (!['approved', 'effective'].includes(business.state)) return;
  if (await loadExitRequest(tx, ctx.tenantId, business.id))
    throw conflict('EXIT_OPERATION_NOT_AVAILABLE', '离职撤销暂不可用');
}

/**
 * 唯一入口。create 的调用方须已持员工行锁；返回需要保存的确认记录（create 写入新扩展行，submit 由调用方 saveAck）。
 * provided：提交时请求带来的令牌（创建时取 exit.pendingTransferAck）。
 */
export async function requireExitGate(
  tx: Tx,
  ctx: EmploymentContext,
  operation: ExitOperation,
  target: ExitGateTarget,
  provided?: string,
): Promise<ExitGateResult> {
  const kind = target.kind ?? target.business?.payload.kind ?? 'leave';
  if (kind === 'retirement') {
    if (operation === 'update' && target.business && target.patch)
      assertExitDatesUnchanged(target.business, target.patch);
    return { ack: null };
  }
  const row = target.business ? await loadExitRequest(tx, ctx.tenantId, target.business.id) : undefined;
  await requireExitPermission(ctx, operation, { ...target, ...(row ? { row } : {}) });
  switch (operation) {
    case 'create':
      return { ack: await createConditions(tx, ctx, target) };
    case 'update':
      assertExitDatesUnchanged(target.business!, target.patch ?? {});
      return { ack: null };
    case 'submit':
      return { ack: await submitConditions(tx, ctx, target, provided) };
    case 'cancel':
      await cancelConditions(tx, ctx, target.business!);
      return { ack: null };
    case 'retry':
      if (target.business && (await loadExitRequest(tx, ctx.tenantId, target.business.id)))
        throw conflict('EXIT_ACTIVATION_NOT_AVAILABLE', '离职生效暂不可用');
      return { ack: null };
    default:
      return { ack: null };
  }
}
