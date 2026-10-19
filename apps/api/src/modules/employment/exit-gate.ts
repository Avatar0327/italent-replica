/**
 * 离职写入口公共门禁（R2-T03 §4A）：kind=leave / retirement 所有公开入口的唯一前置条件实现。
 * 顺序固定：功能操作权 + 按钮权 + 字段权（复用 context.ts requireEmploymentWrite，不以 Employment.Create / Edit / Delete
 * 代替 Dimission* 四个按钮）→ 范围由调用方入口先验（readContext / authorizeBusinessWrite）→ 本文件的前置条件：
 * 日期创建后不可改（§7.2，DEC-499）、同员工无未办结离职、字典启用、§8A 逾期迟到调动、§8B 转正在途、§8 在途调动确认令牌、
 * §18.1 撤销（B4 前对 approved / effective 不提供）。所有拒绝发生在首个写之前（调用方在命令事务内先调用本门禁）。
 * 退休（R2-T04）只受日期规则约束；没有扩展行的离职（可信造数）保持 main 行为。
 */
import { createHmac } from 'node:crypto';
import { and, eq, exitRequests, sql, type Tx } from '@italent/db';
import { EXIT_BUTTONS, PROBATION_ASSESSMENT_OBJECT } from '@italent/domain';
import { AppError } from '../../errors.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { findOverdueTransfers } from './activation-store.js';
import { assessmentVoidNotice, inFlightAssessments, type InFlightAssessment } from './assessment-in-flight.js';
import { EMPLOYMENT_OBJECT, employmentCreator, requireEmploymentWrite } from './context.js';
import { currentEmploymentCycle } from './cycles.js';
import { assertExitDictionaryEnabled } from './exit-dictionaries.js';
import type { ExitOptions } from './exit-initiation.js';
import { rowsOf } from './record-store.js';
import { plannedEffectiveDate } from './timeline.js';
import type { LockedEmploymentBusiness } from './record-store.js';
import type { BusinessKind, EmploymentBusinessPatch, EmploymentContext } from './types.js';
import { visibleEmploymentRecords } from './visibility.js';

export type ExitOperation = 'create' | 'submit' | 'update' | 'withdraw' | 'cancel' | 'retry';
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

interface PermissionSpec {
  readonly op: 'create' | 'update' | 'delete';
  readonly payload: object;
  readonly buttons: readonly string[];
}

/** 每个操作要过的 对象操作 + 载荷 + 按钮；统一经 requireEmploymentWrite，不新增权限原语。 */
function permissionSpec(operation: ExitOperation, target: ExitGateTarget): PermissionSpec | null {
  switch (operation) {
    case 'create':
      // 自助 / 经理代发的发起人按钮归 F-020（暂名 Portal.ExitApply / Team.ExitApply）
      if (target.initiation && target.initiation !== 'hr') return null;
      return {
        op: 'create',
        payload: createPayload(target),
        buttons: [target.mode === 'direct' ? BUTTON.direct : BUTTON.application],
      };
    case 'update':
      return { op: 'update', payload: { ...target.patch, ...target.payload }, buttons: [BUTTON.edit] };
    case 'submit':
    case 'withdraw':
      return !target.row || target.row.initiator === 'hr'
        ? { op: 'update', payload: {}, buttons: [BUTTON.application] }
        : null;
    case 'cancel':
      return { op: target.deleting ? 'delete' : 'update', payload: {}, buttons: [BUTTON.cancel] };
    case 'retry':
      // RetryActivation 与 Dimission 的交集
      return { op: 'update', payload: {}, buttons: [BUTTON.retry, BUTTON.direct] };
  }
}

/** 功能权 + 按钮权 + 字段权；可信上下文（无授权器）直接放行。范围由入口层先验。 */
export async function requireExitPermission(ctx: EmploymentContext, operation: ExitOperation, target: ExitGateTarget) {
  if (!ctx.authorize || target.approvalEdit) return;
  const spec = permissionSpec(operation, target);
  if (!spec) return;
  // 空载荷的命令类按钮（提交 / 撤回 / 撤销 / 重试）只校验按钮
  const options = Object.keys(spec.payload).length ? {} : { commandOnly: true };
  for (const button of spec.buttons)
    await requireEmploymentWrite(ctx, spec.op, spec.payload, button, undefined, options);
}

/** 业务最新载荷的 kind（入口判断是否离职单；不加锁）。 */
export async function businessKind(tx: Tx, tenantId: string, businessId: string): Promise<string | undefined> {
  const [row] = rowsOf<{ kind: string }>(
    await tx.execute(sql`SELECT kind FROM employment_payload_versions WHERE tenant_id=${tenantId}
      AND business_id=${businessId}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  return row?.kind;
}

/** 业务最新状态（命令内复核用；不加锁）。 */
export async function businessState(tx: Tx, tenantId: string, businessId: string): Promise<string | undefined> {
  const [row] = rowsOf<{ state: string }>(
    await tx.execute(sql`SELECT state FROM employment_state_events WHERE tenant_id=${tenantId}
      AND business_id=${businessId}::uuid ORDER BY event_no DESC LIMIT 1`),
  );
  return row?.state;
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

/** 实际离岗日不晚于最后工作日（设计 §2.1 actual_leave_date ≤ 最后工作日；#388 P2-2）：新建按请求日期，编辑按当前载荷。 */
export function assertActualLeaveDate(actualLeaveDate: string | undefined, lastWorkDate: string | null | undefined) {
  if (actualLeaveDate && lastWorkDate && actualLeaveDate > lastWorkDate)
    throw new AppError('VALIDATION_FAILED', '实际离岗日不能晚于最后工作日', {
      reason: 'EXIT_ACTUAL_LEAVE_DATE_AFTER_LAST_WORK_DATE',
      lastWorkDate,
    });
}

// ---- 在途申请清单与披露（§8 / §8A / §8B）-------------------------------------------------------------------

export interface InFlight {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly planned: string;
  /** 最新载荷的生效日（已落地记录即实际生效日）。 */
  readonly effectiveDate: string;
  readonly departmentId: string | null;
  readonly landed: boolean;
}

/** 候选查询（inFlightApplications）至多返回 1001 条；超过这里的上限即整单拒绝，不消费截断清单。 */
export const VOID_LIMIT = 1000;
export const exceedsVoidLimit = (candidates: readonly unknown[]) => candidates.length > VOID_LIMIT;

/** 候选条件推进 SQL（过滤后再取上限），避免“先截断再剔除”漏掉真实超限（F-237）。 */
export interface InFlightFilter {
  /** 只要还没落地成任职记录的。 */
  readonly unlanded?: boolean;
  readonly excludeId?: string;
  /** 已批准的只保留计划生效日晚于该日的（早于等于该日的会先于离职落地，§5.0 队列）。 */
  readonly approvedAfter?: string;
  /** 只要已落地且最新载荷生效日晚于该日的（已落地的未来生效调动）。 */
  readonly landedEffectiveAfter?: string;
}

/** 员工名下指定类型的未办结申请（最新载荷 + 最新状态；计划生效日只取 §5.0A）。 */
export async function inFlightApplications(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  kinds: readonly string[],
  states: readonly string[],
  mode: 'application' | null = 'application',
  filter: InFlightFilter = {},
): Promise<InFlight[]> {
  const planned = plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`);
  const landedAfter = filter.landedEffectiveAfter;
  const landed = sql`EXISTS (SELECT 1 FROM employment_records r WHERE r.tenant_id=b.tenant_id AND r.id=b.id)`;
  return rowsOf<InFlight>(
    await tx.execute(sql`
      SELECT b.id, p.kind, s.state, ${planned}::text AS planned, p.effective_date::text AS "effectiveDate",
        p.department_id AS "departmentId", ${landed} AS landed
      FROM employment_business_objects b
      JOIN LATERAL (SELECT * FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
        AND (${mode}::text IS NULL OR p.mode=${mode}::text)
        AND p.kind = ANY(${`{${kinds.join(',')}}`}::text[]) AND s.state = ANY(${`{${states.join(',')}}`}::text[])
        ${filter.unlanded ? sql`AND NOT ${landed}` : sql``}
        ${filter.landedEffectiveAfter ? sql`AND ${landed} AND p.effective_date > ${landedAfter}::date` : sql``}
        ${filter.excludeId ? sql`AND b.id<>${filter.excludeId}::uuid` : sql``}
        ${filter.approvedAfter ? sql`AND (s.state<>'approved' OR ${planned} > ${filter.approvedAfter}::date)` : sql``}
      ORDER BY planned, b.id LIMIT 1001`),
  );
}

export interface Disclosable {
  readonly id: string;
  readonly effectiveDate: string;
  readonly departmentId: string | null;
  readonly extra?: object;
}

const DISCLOSE_LIMIT = 1000;

/**
 * 预览用披露（F-237）：清单超过 disclose 的单次上限时受控分批披露后汇总，逐项裁剪口径与 disclose 完全一致；
 * 只给只读预览用（候选查询至多 1001 条，故至多两批），保存 / 门禁路径仍走 disclose，不全局放宽。
 */
export async function batchDisclose(tx: Tx, ctx: EmploymentContext, employeeId: string, rows: readonly Disclosable[]) {
  const parts = [];
  for (let from = 0; from === 0 || from < rows.length; from += DISCLOSE_LIMIT)
    parts.push(await disclose(tx, ctx, employeeId, rows.slice(from, from + DISCLOSE_LIMIT)));
  return {
    items: parts.flatMap((part) => part.items),
    hiddenCount: parts.reduce((sum, part) => sum + part.hiddenCount, 0),
  };
}

/**
 * 披露：逐项按 DEC-177 可见性 + 字段查看权裁剪，不可见的只计件数 hiddenCount（响应的每一层都按字段权限裁剪）。
 * 返回形态固定为 { items, hiddenCount }，items 只含 businessId / effectiveDate（及调用方附加的 extra）。
 */
export async function disclose(tx: Tx, ctx: EmploymentContext, employeeId: string, rows: readonly Disclosable[]) {
  if (rows.length > DISCLOSE_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '在途申请过多，请先处理');
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

/** §8A：逾期迟到调动（A 未落地申请 / B 已落地联动未完成）的披露；没有返回 null（预览与门禁共用）。 */
export async function overdueTransferBlocker(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const { blocking } = await findOverdueTransfers(tx, ctx, employeeId);
  if (!blocking.length) return null;
  const rows = blocking.map((item) => ({ ...item, extra: { materialized: item.materialized } }));
  return disclose(tx, ctx, employeeId, rows);
}

/** §8A → 409 EXIT_LATE_TRANSFER_PENDING。 */
async function assertNoOverdueTransfer(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const found = await overdueTransferBlocker(tx, ctx, employeeId);
  if (found) throw conflict('EXIT_LATE_TRANSFER_PENDING', '存在已过计划生效日仍未执行的调动，请先处理', found);
}

/** 租户里按业务类型登记的“转正”任职类型（劳务转正式随 R2-T07 / BE-6 加入时自动纳入）。 */
export const REGULARIZATION_KINDS = ['intern_regularization', 'labor_regularization'] as const;

const plannedRows = (rows: readonly InFlight[]) =>
  rows.map((row) => ({ id: row.id, effectiveDate: row.planned, departmentId: row.departmentId }));

/** §8B：审批中、计划生效日 ≤ 最后工作日的劳务转正式 / 实习转正的披露；没有返回 null。 */
export async function regularizationBlocker(tx: Tx, ctx: EmploymentContext, employeeId: string, lastWorkDate: string) {
  const rows = (await inFlightApplications(tx, ctx, employeeId, REGULARIZATION_KINDS, ['in_review'])).filter(
    (row) => row.planned <= lastWorkDate,
  );
  return rows.length ? disclose(tx, ctx, employeeId, plannedRows(rows)) : null;
}

/** §8B → 409 EXIT_REGULARIZATION_IN_FLIGHT。 */
async function assertNoRegularizationInFlight(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
) {
  const found = await regularizationBlocker(tx, ctx, employeeId, lastWorkDate);
  if (found) throw conflict('EXIT_REGULARIZATION_IN_FLIGHT', '存在审批中的转正流程，请先处理', found);
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
 * 披露在途考核（F-229）：先按员工与任职范围裁剪（与 disclose 同口径，看不到的只计 hiddenCount），再按考核对象的字段查看权
 * 决定每项带出的字段；看不到“考核类型”时提示文案也不带类型名。
 */
export async function assessmentNoticeItems(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  rows: readonly InFlightAssessment[],
) {
  const shown = await disclose(
    tx,
    ctx,
    employeeId,
    rows.map((row) => ({ id: row.id, effectiveDate: row.assessmentDate, departmentId: row.departmentId })),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const viewable = ctx.authorize
    ? await getModuleViewableFieldsInTransaction(
        { authorize: ctx.authorize, clock: () => ctx.now },
        ctx,
        PROBATION_ASSESSMENT_OBJECT,
        tx,
      )
    : undefined;
  const may = (field: string) => viewable === undefined || viewable.has(field);
  return {
    items: shown.items.map((item) => {
      const row = byId.get(item.businessId)!;
      return {
        assessmentId: row.id,
        ...(may('assessmentType') ? { assessmentType: row.assessmentType } : {}),
        ...(may('assessmentName') ? { assessmentName: row.assessmentName } : {}),
        ...(may('assessmentDate') ? { assessmentDate: row.assessmentDate } : {}),
        ...(may('status') ? { status: row.status } : {}),
        message: assessmentVoidNotice(row, may('assessmentType')),
      };
    }),
    hiddenCount: shown.hiddenCount,
  };
}

/**
 * 确认清单 S = 审批中的调动（不论生效日，DEC-166）∪ 已批准未落地且计划生效日 > L 的调动（DEC-220，按 §5.0A 计划日比较）
 * ∪ 在途考核（F-229，DEC-617：审批中 / 已驳回待重提，离职生效时终止作废）。
 * 集合为空无需确认（返回 null）；非空时令牌与已存哈希 / 请求带的令牌之一一致才算确认，否则 409 并给出新令牌。
 * 没有在途考核时集合与令牌与 F-229 之前逐位相同。
 * 调动部分的条件整个推进 SQL 后再取上限（F-241，与 voidCandidates 同一机制）：先截断再在 JS 里剔除前序会让前序占去名额，
 * 初次确认少覆盖、前序落地后重算又多出来。超过 VOID_LIMIT 条（查询取 1001 条，无法区分恰好 1001 与被截断）时不生成令牌，
 * 返回 tooMany。同一时刻下 S 的调动部分是 voidCandidates 的子集，但这只是上限口径一致，不能据此推出生效时必然超限
 * （申请可在确认后被处理或落地）。
 */
export async function pendingTransferAckSet(tx: Tx, ctx: EmploymentContext, employeeId: string, lastWorkDate: string) {
  const rows = await inFlightApplications(tx, ctx, employeeId, ['transfer'], ['in_review', 'approved'], 'application', {
    unlanded: true,
    approvedAfter: lastWorkDate,
  });
  const assessments = await inFlightAssessments(tx, ctx.tenantId, employeeId);
  if (exceedsVoidLimit(rows)) return { tooMany: true as const, assessments };
  if (!rows.length && !assessments.length) return null;
  const ids = [...rows.map((row) => row.id), ...assessments.map((row) => row.id)].sort();
  return {
    tooMany: false as const,
    ids,
    hash: ackToken(ctx, employeeId, lastWorkDate, ids),
    rows: plannedRows(rows),
    assessments,
  };
}

async function checkPendingTransferAck(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  provided: string | undefined,
  stored: AckRecord | null,
): Promise<AckRecord | null> {
  const set = await pendingTransferAckSet(tx, ctx, employeeId, lastWorkDate);
  if (!set) return null;
  if (set.tooMany)
    throw conflict('EXIT_APPLICATIONS_TOO_MANY', '在途调动申请过多，请先处理后再办理离职', { limit: VOID_LIMIT });
  const { ids, hash } = set;
  if (provided === hash || stored?.hash === hash) return { ids, hash };
  const withAssessments = set.assessments.length > 0;
  // 只有在途考核时用单独的原因码，客户端按它显示 DEC-617 的提示；令牌、确认入参与保存方式与调动完全一致
  throw conflict(
    set.rows.length ? 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' : 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED',
    set.rows.length
      ? `离职生效时将作废以下调动申请${withAssessments ? '和在途考核流程' : ''}，请确认`
      : '离职生效时将终止作废在途考核流程，请确认',
    {
      ackToken: hash,
      ...(await disclose(tx, ctx, employeeId, set.rows)),
      ...(withAssessments ? { assessments: await assessmentNoticeItems(tx, ctx, employeeId, set.assessments) } : {}),
    },
  );
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
export const leavesInProgress = (tx: Tx, ctx: EmploymentContext, employeeId: string) =>
  inFlightApplications(tx, ctx, employeeId, ['leave'], ['draft', 'in_review', 'approved', 'rejected'], null);

async function assertNoLeaveInProgress(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  if ((await leavesInProgress(tx, ctx, employeeId)).length)
    throw conflict('EXIT_IN_PROGRESS', '该员工已有未办结的离职');
}

async function createConditions(tx: Tx, ctx: EmploymentContext, target: ExitGateTarget): Promise<AckRecord | null> {
  const exit = target.exit ?? {};
  const lastWorkDate = target.lastWorkDate!;
  assertActualLeaveDate(exit.actualLeaveDate, lastWorkDate);
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

/** 撤销在 B4 前对 approved / effective 离职不提供（§18.1 末段），不存在绕过 §6B 的删除路径。 */
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
      assertActualLeaveDate(
        (target.payload as { actualLeaveDate?: string } | undefined)?.actualLeaveDate,
        target.business!.payload.lastWorkDate,
      );
      return { ack: null };
    case 'submit':
      return { ack: await submitConditions(tx, ctx, target, provided) };
    case 'cancel':
      await cancelConditions(tx, ctx, target.business!);
      return { ack: null };
    default:
      return { ack: null };
  }
}
