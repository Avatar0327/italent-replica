/**
 * 节点动作（REQ-APV-003，`14` §8.2）：同意、驳回、转交、加签、审批中编辑；发起人撤回、重提、催办；
 * 管理员只能转交或干预，不得代签（DEC-063），转交给自己须填理由并醒目标注（DEC-070）；盲审转异常管理员（DEC-069）。
 */
import { sql, type Tx } from '@italent/db';
import type { ApprovalNode } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorBody } from '../../errors.js';
import { ADAPTERS } from './adapters.js';
import {
  approvalError,
  assertRevision,
  auditApproval,
  emitOutbox,
  rowsOf,
  type ApprovalContext,
  type Row,
} from './context.js';
import { blindFields } from './disclosure.js';
import { advanceFrom, afterNodeApproved, nodeIndex, openRun, persistRun, resume, type Run } from './engine.js';
import { applyMessageRules, notifyTodo, notifyUrge } from './notifications.js';
import { userOfPerson } from './resolver.js';
import { appendLog, cancelPending, closeTask, insertTask, instanceOfTask, loadTasks, type TaskRow } from './store.js';

export interface Outcome {
  readonly status: ContentfulStatusCode;
  readonly body: { readonly instanceId: string } | ErrorBody;
}

const ok = (run: Run): Outcome => ({ status: 200, body: { instanceId: run.instance.id } });

interface TaskScene {
  readonly run: Run;
  readonly task: TaskRow;
  readonly node: ApprovalNode;
}

async function openTask(tx: Tx, ctx: ApprovalContext, taskId: string): Promise<TaskScene> {
  const run = await openRun(tx, ctx, await instanceOfTask(tx, ctx.tenantId, taskId));
  const task = (await loadTasks(tx, ctx.tenantId, run.instance.id)).find((candidate) => candidate.id === taskId)!;
  // DEC-063：只有被分配任务的人能处理；管理员须先转交（DEC-070），不能以他人名义审批。
  if (task.assigneeUserId !== ctx.userId)
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE', '只有当前审批人可以处理该任务');
  return { run, task, node: run.version.nodes[nodeIndex(run, task.nodeKey)]! };
}

function assertOpen(scene: TaskScene, ctx: ApprovalContext): void {
  assertRevision(ctx.expectedRevision, scene.run.instance.revision);
  if (scene.run.instance.status !== 'running' || scene.task.status !== 'pending') {
    throw approvalError('CONFLICT', 'APPROVAL_TASK_CLOSED', '该任务已处理或流程已结束');
  }
}

/**
 * DEC-058 / DEC-069：变化字段不可见时不能同意也不能驳回；在办任务自动转异常管理员，流程不卡死。
 * 调用前必须已通过 assertOpen：过期 revision 或已处理的任务不能触发自动转交（AGENTS §10「并发」）。
 */
async function blindReview(
  tx: Tx,
  scene: TaskScene,
  viewable: ReadonlySet<string> | undefined,
): Promise<Outcome | null> {
  const hidden = blindFields(scene.run.snapshot, viewable);
  if (!hidden.length) return null;
  const { run, task } = scene;
  const admin = run.version.exceptionAdminUserId!;
  await closeTask(tx, run.ctx, task.id, 'transferred');
  const next = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: task.nodeKey,
    assigneeUserId: admin,
    origin: 'blind_review',
    status: 'pending',
    isExceptionAdmin: true,
    parentTaskId: task.id,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'blind_review_exception_admin',
    nodeKey: task.nodeKey,
    taskId: next,
    detail: { fromUserId: task.assigneeUserId, toUserId: admin, fields: hidden },
  });
  await notifyTodo(tx, run.ctx, run.instance, next, admin);
  run.events.push('approval.task.transferred');
  await persistRun(tx, run, 'approval.task.blind_review');
  const message = '本单含您无权查看且已变更的字段，无法审批';
  return { status: 403, body: { error: { code: 'FORBIDDEN', message, details: { reason: 'APPROVAL_BLIND_REVIEW' } } } };
}

function editableInput(node: ApprovalNode, fields: Row, viewable: ReadonlySet<string> | undefined): Row {
  const keys = Object.keys(fields);
  const denied = keys.filter(
    (key) => !node.editableFields.includes(key) || (viewable !== undefined && !viewable.has(key)),
  );
  if (!keys.length || denied.length) {
    throw approvalError('FORBIDDEN', 'APPROVAL_FIELD_NOT_EDITABLE', '只能编辑本节点开放且您可查看的字段', {
      fields: denied,
    });
  }
  return fields;
}

async function applyEdit(tx: Tx, scene: TaskScene, fields: Row): Promise<void> {
  const { run, task } = scene;
  const adapter = ADAPTERS[run.instance.businessType];
  await adapter.edit(tx, run.ctx, run.instance.businessId, fields);
  // 【编辑并同意】随后推进节点：路由部门必须取编辑后的业务单，不能沿用打开任务时的快照。
  run.snapshot = await adapter.snapshot(tx, run.ctx, run.instance.businessId, run.instance.processCode);
  await appendLog(tx, run.ctx, run.instance, {
    event: 'edit',
    nodeKey: task.nodeKey,
    taskId: task.id,
    detail: { fields: Object.keys(fields) },
  });
}

async function auditTask(tx: Tx, run: Run, action: string, before: Row, after: Row): Promise<void> {
  await auditApproval(tx, run.ctx, {
    action,
    objectType: 'approval-instance',
    objectId: run.instance.id,
    before,
    after,
  });
}

export interface DecisionInput {
  readonly taskId: string;
  readonly comment: string | null;
  readonly fields?: Row;
}

export async function approveTask(
  tx: Tx,
  ctx: ApprovalContext,
  input: DecisionInput,
  viewable: ReadonlySet<string> | undefined,
): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  const blocked = await blindReview(tx, scene, viewable);
  if (blocked) return blocked;
  await assertNotSelf(tx, scene.run, ctx.userId);
  const { run, task, node } = scene;
  if (input.fields && Object.keys(input.fields).length) {
    if (node.editMode !== 'with_approve')
      throw approvalError('CONFLICT', 'APPROVAL_EDIT_MODE', '本节点不支持编辑与同意合一');
    await applyEdit(tx, scene, editableInput(node, input.fields, viewable));
  }
  await closeTask(tx, ctx, task.id, 'approved', input.comment);
  await appendLog(tx, ctx, run.instance, {
    event: 'approve',
    nodeKey: task.nodeKey,
    taskId: task.id,
    adminSelfTransfer: task.adminSelfTransfer,
    detail: { comment: input.comment },
  });
  await auditTask(
    tx,
    run,
    'approval.task.approve',
    { status: 'pending', comment: null },
    { status: 'approved', comment: input.comment },
  );
  await applyMessageRules(tx, ctx, run.instance, node, 'approve', task);
  await afterNodeApproved(tx, run, task.nodeKey);
  run.events.push('approval.task.approved');
  await persistRun(
    tx,
    run,
    run.instance.status === 'approved' ? 'approval.instance.complete' : 'approval.instance.advance',
  );
  return ok(run);
}

export async function rejectTask(
  tx: Tx,
  ctx: ApprovalContext,
  input: DecisionInput,
  viewable: ReadonlySet<string> | undefined,
): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  const blocked = await blindReview(tx, scene, viewable);
  if (blocked) return blocked;
  await assertNotSelf(tx, scene.run, ctx.userId);
  const { run, task, node } = scene;
  // DEC-059：节点开关「驳回意见必填」，出厂关闭。
  if (node.rejectCommentRequired && !input.comment?.trim()) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_COMMENT_REQUIRED', '本节点驳回时必须填写意见');
  }
  await closeTask(tx, ctx, task.id, 'rejected', input.comment);
  await cancelPending(tx, ctx, run.instance.id);
  run.instance = { ...run.instance, status: 'returned', currentNodeKey: null, returnedFromNodeKey: node.key };
  await ADAPTERS[run.instance.businessType].rejected(tx, ctx, run.instance.businessId);
  await appendLog(tx, ctx, run.instance, {
    event: 'reject',
    nodeKey: node.key,
    taskId: task.id,
    adminSelfTransfer: task.adminSelfTransfer,
    detail: { comment: input.comment, resubmit: node.rejectResubmit },
  });
  await auditTask(
    tx,
    run,
    'approval.task.reject',
    { status: 'pending', comment: null },
    { status: 'rejected', comment: input.comment },
  );
  await applyMessageRules(tx, ctx, run.instance, node, 'reject', task);
  run.events.push('approval.instance.returned');
  await persistRun(tx, run, 'approval.instance.return');
  return ok(run);
}

/** DEC-058：发起人或异动本人不得审批自己的单据（异常管理员恰为本人时也只能转交）。 */
async function assertNotSelf(tx: Tx, run: Run, userId: string): Promise<void> {
  const subjectUser = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  if (userId === run.instance.initiatorUserId || userId === subjectUser) {
    throw approvalError('CONFLICT', 'APPROVAL_SELF_REVIEW', '发起人或异动本人不能审批自己的单据');
  }
}

/** 转交 / 加签对象：本租户有效成员，且不是发起人或异动本人。 */
async function assertReviewer(tx: Tx, run: Run, userId: string): Promise<void> {
  const [member] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM tenant_memberships
      WHERE tenant_id=${run.ctx.tenantId} AND user_id=${userId}::uuid AND status='active'`),
  );
  if (!member) throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '目标用户不是本租户有效成员');
  await assertNotSelf(tx, run, userId);
}

export interface DelegateInput {
  readonly taskId: string;
  readonly userId: string;
  readonly comment: string | null;
}

export async function transferTask(tx: Tx, ctx: ApprovalContext, input: DelegateInput): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  const { run, task, node } = scene;
  // DEC-069：异常管理员的任务总可转交给有权限者，不受节点开关限制。
  if (!node.actions.transfer && !task.isExceptionAdmin) {
    throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '本节点未开启转交');
  }
  if (input.userId === ctx.userId) throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '不能转交给自己');
  await assertReviewer(tx, run, input.userId);
  await closeTask(tx, ctx, task.id, 'transferred', input.comment);
  const next = await delegate(tx, run, task, input.userId, 'transfer', { comment: input.comment });
  await auditDelegation(tx, run, 'approval.task.transfer', task, next, input, 'transferred');
  await applyMessageRules(tx, ctx, run.instance, node, 'transfer', { id: task.id, assigneeUserId: input.userId });
  await persistRun(tx, run, 'approval.instance.transfer');
  return ok(run);
}

export async function addSign(tx: Tx, ctx: ApprovalContext, input: DelegateInput): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  const { run, task, node } = scene;
  if (!node.actions.addSign) throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '本节点未开启加签');
  await assertReviewer(tx, run, input.userId);
  const tasks = await loadTasks(tx, ctx.tenantId, run.instance.id);
  if (tasks.some((t) => t.nodeKey === task.nodeKey && t.status === 'pending' && t.assigneeUserId === input.userId)) {
    throw approvalError('CONFLICT', 'APPROVAL_ALREADY_ASSIGNED', '该用户已在本节点审批');
  }
  // TODO(需取证 Q-M0-41)：原站加签的类型（前加签 / 后加签 / 并加签）未取证；首版按“同节点全部同意才通过”。
  const next = await delegate(tx, run, task, input.userId, 'add_sign', { comment: input.comment });
  await auditDelegation(tx, run, 'approval.task.add_sign', task, next, input, 'pending');
  await persistRun(tx, run, 'approval.instance.add_sign');
  return ok(run);
}

/** 转交 / 加签与同意 / 驳回一样写任务审计：原任务状态、原 / 新审批人、新任务与意见（AGENTS §10「审计」）。 */
async function auditDelegation(
  tx: Tx,
  run: Run,
  action: string,
  from: TaskRow,
  next: string,
  input: DelegateInput,
  taskStatus: 'transferred' | 'pending',
): Promise<void> {
  await auditTask(
    tx,
    run,
    action,
    { taskStatus: 'pending', assigneeUserId: from.assigneeUserId, newTaskId: null, newTaskStatus: null, comment: null },
    { taskStatus, assigneeUserId: input.userId, newTaskId: next, newTaskStatus: 'pending', comment: input.comment },
  );
}

/** 每次改派都写 outbox，通知处理器按游标消费（AGENTS §10「事件」）。 */
const DELEGATION_EVENTS = {
  transfer: 'approval.task.transferred',
  add_sign: 'approval.task.add_signed',
  admin_transfer: 'approval.task.transferred',
  admin_intervene: 'approval.task.reassigned',
} as const;

async function delegate(
  tx: Tx,
  run: Run,
  from: TaskRow,
  userId: string,
  origin: 'transfer' | 'add_sign' | 'admin_transfer' | 'admin_intervene',
  detail: Row,
  adminSelfTransfer = false,
): Promise<string> {
  const next = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: from.nodeKey,
    assigneeUserId: userId,
    origin,
    status: 'pending',
    isExceptionAdmin: false,
    adminSelfTransfer,
    parentTaskId: from.id,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: origin,
    nodeKey: from.nodeKey,
    taskId: next,
    adminSelfTransfer,
    detail: { fromUserId: from.assigneeUserId, toUserId: userId, ...detail },
  });
  await notifyTodo(tx, run.ctx, run.instance, next, userId);
  run.events.push(DELEGATION_EVENTS[origin]);
  return next;
}

export async function editTask(
  tx: Tx,
  ctx: ApprovalContext,
  input: { taskId: string; fields: Row },
  viewable: ReadonlySet<string> | undefined,
): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  if (scene.node.editMode !== 'separate')
    throw approvalError('CONFLICT', 'APPROVAL_EDIT_MODE', '本节点没有独立的编辑按钮');
  await applyEdit(tx, scene, editableInput(scene.node, input.fields, viewable));
  await persistRun(tx, scene.run, 'approval.task.edit');
  return ok(scene.run);
}

async function openOwn(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<Run> {
  const run = await openRun(tx, ctx, instanceId);
  if (run.instance.initiatorUserId !== ctx.userId)
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有发起人可以执行该操作');
  assertRevision(ctx.expectedRevision, run.instance.revision);
  return run;
}

/** 催办：通知当前节点未审批的人（`14` §9.2）；不改变流程状态，不推进 revision。 */
export async function urge(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<Outcome> {
  const run = await openOwn(tx, ctx, instanceId);
  const node = run.version.nodes.find((candidate) => candidate.key === run.instance.currentNodeKey);
  if (run.instance.status !== 'running' || !run.version.urgeEnabled || !node?.actions.urge) {
    throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '当前节点不允许催办');
  }
  const pending = (await loadTasks(tx, ctx.tenantId, instanceId)).filter((task) => task.status === 'pending');
  await notifyUrge(
    tx,
    ctx,
    run.instance,
    pending.map((task) => ({ taskId: task.id, userId: task.assigneeUserId! })),
  );
  await appendLog(tx, ctx, run.instance, { event: 'urge', nodeKey: node.key, detail: { recipients: pending.length } });
  await auditApproval(tx, ctx, {
    action: 'approval.instance.urge',
    objectType: 'approval-instance',
    objectId: instanceId,
    before: null,
    after: { nodeKey: node.key, recipients: pending.map((task) => task.assigneeUserId) },
  });
  await emitOutbox(tx, ctx, {
    objectType: 'approval-instance',
    objectId: instanceId,
    eventType: 'approval.instance.urged',
    revision: run.instance.revision,
  });
  return ok(run);
}

/**
 * 发起人撤回（AC-TRF-28）。fromBusiness = 业务模块已自行迁移状态（任职申请的“撤回”按钮）。
 */
export async function withdraw(
  tx: Tx,
  ctx: ApprovalContext,
  instanceId: string,
  fromBusiness = false,
): Promise<Outcome> {
  const run = fromBusiness ? await openRun(tx, ctx, instanceId) : await openOwn(tx, ctx, instanceId);
  if (!['running', 'returned'].includes(run.instance.status))
    throw approvalError('CONFLICT', 'APPROVAL_CLOSED', '流程已结束');
  await cancelPending(tx, ctx, instanceId);
  run.instance = { ...run.instance, status: 'withdrawn', currentNodeKey: null };
  if (!fromBusiness) await ADAPTERS[run.instance.businessType].withdrawn(tx, ctx, run.instance.businessId);
  await appendLog(tx, ctx, run.instance, { event: 'withdraw' });
  run.events.push('approval.instance.withdrawn');
  await persistRun(tx, run, 'approval.instance.withdraw');
  return ok(run);
}

/** 业务单据被删除时作废退回中的实例。 */
export async function cancel(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<void> {
  const run = await openRun(tx, ctx, instanceId);
  await cancelPending(tx, ctx, instanceId);
  run.instance = { ...run.instance, status: 'cancelled', currentNodeKey: null };
  await appendLog(tx, ctx, run.instance, { event: 'cancel' });
  run.events.push('approval.instance.cancelled');
  await persistRun(tx, run, 'approval.instance.cancel');
}

export async function resubmit(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<Outcome> {
  const run = await openOwn(tx, ctx, instanceId);
  await ADAPTERS[run.instance.businessType].resubmitted(tx, ctx, run.instance.businessId);
  const saved = await resume(tx, ctx, instanceId);
  return { status: 200, body: { instanceId: saved.id } };
}

export interface AdminInput {
  readonly instanceId: string;
  readonly kind: 'transfer' | 'reassign' | 'jump';
  readonly taskId?: string;
  readonly toUserId?: string;
  readonly toNodeKey?: string;
  readonly reason: string | null;
}

/** 管理员转交 / 干预（DEC-063 / DEC-070）：每次操作单独写审计，原审批人、新审批人、原因齐全。 */
export async function adminAct(tx: Tx, ctx: ApprovalContext, input: AdminInput, scope: SQL): Promise<Outcome> {
  const run = await openRun(tx, ctx, input.instanceId);
  const [covered] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM approval_instances i WHERE i.tenant_id=${ctx.tenantId}
      AND i.id=${input.instanceId}::uuid AND ${scope}`),
  );
  if (!covered) throw approvalError('NOT_FOUND', 'APPROVAL_NOT_FOUND', '审批实例不存在');
  assertRevision(ctx.expectedRevision, run.instance.revision);
  if (run.instance.status !== 'running') throw approvalError('CONFLICT', 'APPROVAL_CLOSED', '流程不在审批中');
  const intervene = input.kind !== 'transfer';
  if ((intervene || input.toUserId === ctx.userId) && !input.reason?.trim()) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_REASON_REQUIRED', '管理员干预或转交给自己时必须填写理由');
  }
  if (input.kind === 'jump') return adminJump(tx, run, input);
  const task = (await loadTasks(tx, ctx.tenantId, run.instance.id)).find((t) => t.id === input.taskId);
  if (!task || task.status !== 'pending')
    throw approvalError('CONFLICT', 'APPROVAL_TASK_CLOSED', '只能转交待处理的任务');
  await assertReviewer(tx, run, input.toUserId!);
  const self = input.toUserId === ctx.userId;
  await closeTask(tx, ctx, task.id, 'transferred', input.reason);
  await delegate(
    tx,
    run,
    task,
    input.toUserId!,
    intervene ? 'admin_intervene' : 'admin_transfer',
    { reason: input.reason },
    self,
  );
  const action = self
    ? 'approval.admin.self_transfer'
    : intervene
      ? 'approval.admin.intervene'
      : 'approval.admin.transfer';
  await auditApproval(tx, ctx, {
    action,
    objectType: 'approval-instance',
    objectId: run.instance.id,
    before: { taskId: task.id, assigneeUserId: task.assigneeUserId, reason: null, adminSelfTransfer: false },
    after: { taskId: task.id, assigneeUserId: input.toUserId, reason: input.reason, adminSelfTransfer: self },
  });
  await persistRun(tx, run, 'approval.instance.admin');
  return ok(run);
}

async function adminJump(tx: Tx, run: Run, input: AdminInput): Promise<Outcome> {
  const index = nodeIndex(run, input.toNodeKey ?? '');
  await cancelPending(tx, run.ctx, run.instance.id);
  await appendLog(tx, run.ctx, run.instance, {
    event: 'admin_intervene',
    detail: { kind: 'jump', toNodeKey: input.toNodeKey, reason: input.reason },
  });
  await auditApproval(tx, run.ctx, {
    action: 'approval.admin.intervene',
    objectType: 'approval-instance',
    objectId: run.instance.id,
    before: { currentNodeKey: run.instance.currentNodeKey, reason: null },
    after: { currentNodeKey: input.toNodeKey, reason: input.reason },
  });
  await advanceFrom(tx, run, index);
  await persistRun(tx, run, 'approval.instance.admin');
  return ok(run);
}
