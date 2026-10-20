/**
 * 离职交接执行（R2 BE-8b2，B64 / B65，DM-R11 / DM-R13 / DM-R14，DEC-632；设计 R2-T03 §0 / §5.1 步骤 8 的 confirmed / cancelled 端口订阅方）。
 * - 自动发起：订阅 exitPostEffectHooks.onConfirmed（端口只对离职申请审批通过调用，直接离职不调用，B-59）。按 exit.handover_trigger 判断开关与
 *   “包含最后工作日早于审批通过日的人员”；发起人 = 员工本人账号、系统代发（审计操作人为空）。发起在保存点内：没有可用流程、首节点无人等
 *   业务拒绝只留痕（exit_handover.launch_failed），不回滚离职审批；同一离职最多一张进行中 / 已完成的交接（部分唯一索引兜底，重放返回已有的一张）。
 * - 事项：发起时把交接事项设置当时的全部事项整份快照到本单，之后改设置不影响；“交接人”只读文本，不随负责人回填（R2f2）。
 * - 办理：勾选“办理完成”即自动保存（tickHandoverItem，不点同意也生效、不推进节点）；只能改当前待办节点负责的类别
 *   （工作交接节点办“工作交接”类、其他事项交接节点办“其他”类）；“本人事项办完”只统计当前审批人本节点的事项。
 * - 交接未完成不阻止离职生效：本文件不读写离职状态，交接完成与否对离职生效没有影响（B64 本租户配置）。
 * - 撤销离职（onCancelled）：同事务终止进行中的交接并系统撤销审批实例（操作人记系统），已完成的不动。
 * 锁序：员工 → 交接申请行 → 审批实例（与审批回调 exit-handover-adapter.ts 一致）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  checkHandoverTrigger,
  HANDOVER_CANCEL_REASON,
  HANDOVER_NODE_OF_TODO,
  HANDOVER_TRIGGER_DEFAULT,
  handoverLaunchDecision,
  EXIT_HANDOVER_TRIGGER_KEY,
  tenantLocalDate,
  type HandoverDisplayStatus,
  type HandoverEndReason,
  type HandoverTriggerSetting,
} from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { revokeBySystem } from '../approval/actions.js';
import { schedulerAwareContext, type ApprovalContext } from '../approval/context.js';
import { userOfPerson } from '../approval/resolver.js';
import { activeInstanceOf } from '../approval/store.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertRevision } from './context.js';
import { exitPostEffectHooks, type ExitCancelledEvent, type ExitConfirmedEvent } from './exit-confirmation.js';
import { listHandoverItems } from './exit-handover-items.js';
import {
  insertHandoverRequest,
  latestHandoverOfExit,
  linkHandoverInstance,
  listRequestItems,
  liveHandoverOfExit,
  loadHandoverRequest,
  moveHandoverRequest,
  type HandoverItemRow,
  type HandoverRequestRow,
} from './exit-handover-store.js';
import { findCurrentRecord } from './read-model.js';
import { lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const REQUEST_TYPE = 'exit_handover_request';

export type LaunchResult =
  | { readonly outcome: 'launched' | 'exists'; readonly requestId: string }
  | { readonly outcome: 'skipped' | 'failed'; readonly reason: string };

async function auditHandover(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId' | 'commandId' | 'now'> & { readonly actorUserId?: string | null },
  action: string,
  objectType: string,
  objectId: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId ?? null,
    action: `exit_handover.${action}`,
    objectType,
    objectId,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function readTrigger(tx: Tx, tenantId: string): Promise<HandoverTriggerSetting> {
  const checked = checkHandoverTrigger((await readEffectiveSetting(tx, tenantId, EXIT_HANDOVER_TRIGGER_KEY)).value);
  return checked.ok ? checked.value : HANDOVER_TRIGGER_DEFAULT;
}

async function lastWorkDateOf(tx: Tx, tenantId: string, exitId: string): Promise<string | null> {
  const [row] = rowsOf<{ lastWorkDate: string | null }>(
    await tx.execute(sql`SELECT last_work_date::text AS "lastWorkDate" FROM employment_payload_versions
      WHERE tenant_id = ${tenantId} AND business_id = ${exitId}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  return row?.lastWorkDate ?? null;
}

/** 审批中心上下文：发起人换成员工本人账号，审批发起日志标“系统代发”。 */
const launchContext = (ctx: EmploymentContext, initiatorUserId: string) =>
  ({ ...ctx, userId: initiatorUserId, expectedRevision: 0, systemProxy: true }) as unknown as ApprovalContext;

/** 发起入口（订阅方本体，导出供重放测试直调）：只对离职申请；调用方已持员工锁与离职业务头锁。 */
export async function launchExitHandover(
  tx: Tx,
  ctx: EmploymentContext,
  event: ExitConfirmedEvent,
): Promise<LaunchResult> {
  if (event.kind !== 'leave' || event.mode !== 'application') return { outcome: 'skipped', reason: 'NOT_APPLICABLE' };
  const live = await liveHandoverOfExit(tx, ctx.tenantId, event.businessId);
  if (live) return { outcome: 'exists', requestId: live.id };
  const decision = handoverLaunchDecision(await readTrigger(tx, ctx.tenantId), {
    lastWorkDate: await lastWorkDateOf(tx, ctx.tenantId, event.businessId),
    approvedOn: tenantLocalDate(ctx.now, ctx.timezone),
  });
  if (decision !== 'launch') return { outcome: 'skipped', reason: decision.toUpperCase() };
  const initiatorUserId = await userOfPerson(tx, ctx.tenantId, event.employeeId);
  if (!initiatorUserId) return skip(tx, ctx, event, 'NO_INITIATOR_ACCOUNT');
  try {
    // 保存点：业务拒绝（没有可用流程、首节点无审批人……）整体回退，只留痕，不拖垮离职审批
    return await tx.transaction((savepoint) => createAndStart(savepoint, ctx, event, initiatorUserId));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const reason = (error.details as { reason?: string } | undefined)?.reason ?? error.code;
    await auditHandover(tx, ctx, 'launch_failed', 'exit-request', event.businessId, null, { reason });
    return { outcome: 'failed', reason };
  }
}

async function skip(tx: Tx, ctx: EmploymentContext, event: ExitConfirmedEvent, reason: string): Promise<LaunchResult> {
  await auditHandover(tx, ctx, 'skipped', 'exit-request', event.businessId, null, { reason });
  return { outcome: 'skipped', reason };
}

async function createAndStart(
  tx: Tx,
  ctx: EmploymentContext,
  event: ExitConfirmedEvent,
  initiatorUserId: string,
): Promise<LaunchResult> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const current = await findCurrentRecord(tx, ctx.tenantId, event.employeeId, today);
  const items = await listHandoverItems(tx, ctx.tenantId);
  const id = randomUUID();
  await insertHandoverRequest(tx, {
    id,
    tenantId: ctx.tenantId,
    exitRequestId: event.businessId,
    employeeId: event.employeeId,
    departmentId: current?.fields.departmentId ?? null,
    initiatorUserId,
    commandId: ctx.commandId,
    now: ctx.now,
    items,
  });
  // 动态加载：审批引擎经 ADAPTERS 反向依赖本模块的适配器（同意向退休申请的做法）
  const { startOrResume } = await import('../approval/engine.js');
  const instance = await startOrResume(tx, launchContext(ctx, initiatorUserId), {
    businessType: 'exit_handover',
    businessId: id,
  });
  await linkHandoverInstance(tx, ctx.tenantId, id, instance.id);
  await auditHandover(tx, ctx, 'launch', REQUEST_TYPE, id, null, {
    exitRequestId: event.businessId,
    employeeId: event.employeeId,
    initiatorUserId,
    itemCount: items.length,
    systemProxy: true,
  });
  return { outcome: 'launched', requestId: id };
}

/** 撤销离职（订阅 onCancelled，与撤销同事务）：进行中的交接置已终止并系统撤销审批实例；已完成 / 已终止的不动。 */
export async function terminateHandoverOnCancel(tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent) {
  if (event.kind !== 'leave') return;
  const live = await liveHandoverOfExit(tx, ctx.tenantId, event.businessId);
  if (!live || live.state !== 'in_progress') return;
  const row = await loadHandoverRequest(tx, ctx.tenantId, live.id, true);
  if (row.state !== 'in_progress') return;
  await moveHandoverRequest(tx, ctx, row, { state: 'terminated', endReason: 'exit_cancelled' });
  const active = await activeInstanceOf(tx, ctx.tenantId, 'exit_handover', row.id);
  if (active)
    await revokeBySystem(
      tx,
      schedulerAwareContext({ ...ctx, userId: SYSTEM_USER_ID, expectedRevision: 0 } as unknown as ApprovalContext),
      active.id,
      HANDOVER_CANCEL_REASON,
    );
  await auditHandover(
    tx,
    ctx,
    'terminate',
    REQUEST_TYPE,
    row.id,
    { state: row.state },
    {
      state: 'terminated',
      endReason: 'exit_cancelled',
      reason: HANDOVER_CANCEL_REASON,
    },
  );
}

/** 锁序入口：员工 → 交接申请行；调用方随后（审批动作内）才锁实例。 */
export async function lockHandoverRequest(tx: Tx, ctx: EmploymentContext, id: string): Promise<HandoverRequestRow> {
  const peek = await loadHandoverRequest(tx, ctx.tenantId, id);
  await lockEmploymentEmployee(tx, ctx, peek.employeeId);
  return loadHandoverRequest(tx, ctx.tenantId, id, true);
}

/** 审批中心回写（适配器调用）：通过 → 已完成；不同意 / 驳回 / 撤回 → 已终止。只处理进行中的，重复回调不重复写。 */
export async function settleHandoverFromApproval(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  outcome: 'approved' | HandoverEndReason,
) {
  const row = await lockHandoverRequest(tx, ctx, id);
  if (row.state !== 'in_progress') return;
  const next =
    outcome === 'approved' ? ({ state: 'completed' } as const) : ({ state: 'terminated', endReason: outcome } as const);
  await moveHandoverRequest(tx, ctx, row, next);
  await auditHandover(
    tx,
    { ...ctx, actorUserId: ctx.userId === SYSTEM_USER_ID ? null : ctx.userId },
    next.state === 'completed' ? 'complete' : 'terminate',
    REQUEST_TYPE,
    id,
    { state: row.state },
    next,
  );
}

// ---- 读口与办理 ------------------------------------------------------------------------------------------------------

export interface HandoverItemDetail extends Omit<HandoverItemRow, 'todoType'> {
  readonly todoType: string;
  readonly responsibleNodeKey: string;
  readonly editable: boolean;
}

export interface HandoverMine {
  readonly nodeKey: string;
  readonly total: number;
  readonly done: number;
  readonly allDone: boolean;
}

export interface HandoverDetail {
  readonly id: string;
  readonly exitRequestId: string;
  readonly employeeId: string;
  readonly status: HandoverDisplayStatus;
  readonly endReason: HandoverEndReason | null;
  readonly approvalInstanceId: string | null;
  readonly revision: number;
  readonly items: readonly HandoverItemDetail[];
  readonly mine: HandoverMine | null;
}

/** 查看人在该交接实例上当前待办的节点（没有待办返回 null）。 */
async function pendingNodeOf(tx: Tx, tenantId: string, instanceId: string | null, userId: string | null) {
  if (!instanceId || !userId) return null;
  const [row] = rowsOf<{ nodeKey: string }>(
    await tx.execute(sql`SELECT node_key AS "nodeKey" FROM approval_tasks WHERE tenant_id = ${tenantId}
      AND instance_id = ${instanceId}::uuid AND assignee_user_id = ${userId}::uuid AND status = 'pending' LIMIT 1`),
  );
  return row?.nodeKey ?? null;
}

/** 交接申请的参与人：发起人（员工本人），或在该审批实例上有过任务的审批人。 */
export async function isHandoverParticipant(tx: Tx, tenantId: string, row: HandoverRequestRow, userId: string) {
  if (row.initiatorUserId === userId) return true;
  if (!row.approvalInstanceId) return false;
  const [found] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM approval_tasks WHERE tenant_id = ${tenantId}
      AND instance_id = ${row.approvalInstanceId}::uuid AND assignee_user_id = ${userId}::uuid LIMIT 1`),
  );
  return Boolean(found);
}

function mineOf(items: readonly HandoverItemRow[], nodeKey: string | null): HandoverMine | null {
  if (!nodeKey) return null;
  const own = items.filter((item) => HANDOVER_NODE_OF_TODO[item.todoType] === nodeKey);
  if (!own.length) return null;
  const done = own.filter((item) => item.done).length;
  return { nodeKey, total: own.length, done, allDone: done === own.length };
}

/** 详情：事项 + 每项办理状态；viewerUserId 为空（HR 视角）时全部只读。editable = 进行中且查看人当前待办节点正是该项负责节点。 */
export async function handoverDetail(
  tx: Tx,
  tenantId: string,
  row: HandoverRequestRow,
  viewerUserId: string | null,
): Promise<HandoverDetail> {
  const items = await listRequestItems(tx, tenantId, row.id);
  const nodeKey =
    row.state === 'in_progress' ? await pendingNodeOf(tx, tenantId, row.approvalInstanceId, viewerUserId) : null;
  return {
    id: row.id,
    exitRequestId: row.exitRequestId,
    employeeId: row.employeeId,
    status: row.state,
    endReason: row.endReason,
    approvalInstanceId: row.approvalInstanceId,
    revision: row.revision,
    items: items.map((item) => ({
      ...item,
      responsibleNodeKey: HANDOVER_NODE_OF_TODO[item.todoType],
      editable: nodeKey !== null && HANDOVER_NODE_OF_TODO[item.todoType] === nodeKey,
    })),
    mine: mineOf(items, nodeKey),
  };
}

/** 离职详情上的交接状态：没有交接申请 = 未发起（含档案直接离职，R2c）。 */
export async function exitHandoverStatus(tx: Tx, tenantId: string, exitId: string) {
  const row = await latestHandoverOfExit(tx, tenantId, exitId);
  if (!row) return { status: 'not_started' as const, request: null };
  const request = await handoverDetail(tx, tenantId, row, null);
  return { status: request.status, request };
}

const refuse = (code: ErrorCode, message: string, reason: string) => new AppError(code, message, { reason });

/**
 * 勾选 / 取消勾选“办理完成”（自动保存）：If-Match = 事项 revision。顺序：参与人（否则 404，与不存在同一个）→ 交接仍在进行（409）→
 * 查看人有当前待办（403 EXIT_HANDOVER_NOT_ASSIGNEE）→ 该项属于待办节点（403 EXIT_HANDOVER_ITEM_NOT_OWNED）→ revision（409）。
 * 值未变不写、不加 revision。
 */
export async function tickHandoverItem(
  tx: Tx,
  ctx: EmploymentContext,
  requestId: string,
  itemId: string,
  done: boolean,
) {
  const row = await lockHandoverRequest(tx, ctx, requestId);
  if (!(await isHandoverParticipant(tx, ctx.tenantId, row, ctx.userId)))
    throw new AppError('NOT_FOUND', '离职交接申请不存在');
  if (row.state !== 'in_progress')
    throw refuse('CONFLICT', '该交接已结束，不能再办理', 'EXIT_HANDOVER_NOT_IN_PROGRESS');
  const nodeKey = await pendingNodeOf(tx, ctx.tenantId, row.approvalInstanceId, ctx.userId);
  if (!nodeKey) throw refuse('FORBIDDEN', '当前不是你的交接待办', 'EXIT_HANDOVER_NOT_ASSIGNEE');
  const items = await listRequestItems(tx, ctx.tenantId, requestId);
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) throw new AppError('NOT_FOUND', '交接事项不存在');
  if (HANDOVER_NODE_OF_TODO[item.todoType] !== nodeKey)
    throw refuse('FORBIDDEN', '该事项不由当前节点办理', 'EXIT_HANDOVER_ITEM_NOT_OWNED');
  assertRevision(ctx.expectedRevision, item.revision);
  let saved = item;
  if (item.done !== done) {
    const doneAt = done ? ctx.now.toISOString() : null;
    const doneBy = done ? ctx.userId : null;
    await tx.execute(sql`UPDATE exit_handover_request_items SET done = ${done}, done_at = ${doneAt}::timestamptz,
      done_by_user_id = ${doneBy}::uuid, revision = revision + 1, updated_at = ${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${itemId}::uuid`);
    saved = { ...item, done, revision: item.revision + 1 };
    await auditHandover(
      tx,
      { ...ctx, actorUserId: ctx.userId },
      'item_done',
      'exit_handover_request_item',
      itemId,
      { done: item.done },
      { done, requestId, nodeKey },
    );
  }
  const after = items.map((candidate) => (candidate.id === itemId ? saved : candidate));
  return {
    item: { ...saved, responsibleNodeKey: nodeKey, editable: true },
    mine: mineOf(after, nodeKey),
  };
}

exitPostEffectHooks.onConfirmed((tx, ctx, event) => launchExitHandover(tx, ctx, event).then(() => undefined));
exitPostEffectHooks.onCancelled((tx, ctx, event) => terminateHandoverOnCancel(tx, ctx, event));
