/**
 * 节点动作（REQ-APV-003，`14` §8.2）：同意、不同意（出口动作，DEC-144）、驳回、转交、加签、审批中编辑；发起人撤回、
 * 重提、催办；管理员只能转交或干预，不得代签（DEC-063），转交给自己须填理由并醒目标注（DEC-070）；盲审转异常管理员
 * （DEC-069）。会签节点（F-003）的同意 / 不同意按流转规则结算（countersign.ts），驳回任一人即整单驳回。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  blindReviewFields,
  EXIT_LABELS,
  hasExit,
  isCountersign,
  SUBJECT_FILL_APPROVER,
  NODE_ADD_SIGN_TYPES,
  nodeKindOf,
  rejectAllowed,
  tenantLocalDate,
  type AddSignType,
  type ApprovalNode,
  type NodeExit,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorBody } from '../../errors.js';
import { assertNotAddSigner, continueAfterApproval } from './add-sign.js';
import { mergeSeat, mergesSeat, resettle, settleCountersign } from './countersign.js';
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
import {
  advanceFrom,
  assertBusinessUnchanged,
  currentRouting,
  exceptionAdminFor,
  followExit,
  nodeIndex,
  openRun,
  persistRun,
  returnInstance,
  startOrResume,
  type Run,
} from './engine.js';
import { applyMessageRules, notifyTodo, notifyUrge } from './notifications.js';
import { addSignAllowed, isOwnRequest, nodeParticipantsOf, urgeOpen, votesInTransition } from './rules.js';
import { isEligibleApprover, userOfPerson } from './resolver.js';
import { appendLog, cancelPending, closeTask, insertTask, instanceOfTask, loadTasks, type TaskRow } from './store.js';

export interface Outcome {
  readonly status: ContentfulStatusCode;
  readonly body: { readonly instanceId: string } | ErrorBody;
}

export const ok = (run: Run): Outcome => ({ status: 200, body: { instanceId: run.instance.id } });

export interface TaskScene {
  readonly run: Run;
  readonly task: TaskRow;
  readonly node: ApprovalNode;
}

export async function openTask(tx: Tx, ctx: ApprovalContext, taskId: string): Promise<TaskScene> {
  const run = await openRun(tx, ctx, await instanceOfTask(tx, ctx.tenantId, taskId));
  const task = (await loadTasks(tx, ctx.tenantId, run.instance.id)).find((candidate) => candidate.id === taskId)!;
  // DEC-063：只有被分配任务的人能处理；管理员须先转交（DEC-070），不能以他人名义审批。
  if (task.assigneeUserId !== ctx.userId)
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_ASSIGNEE', '只有当前审批人可以处理该任务');
  return { run, task, node: run.version.nodes[nodeIndex(run, task.nodeKey)]! };
}

export function assertOpen(scene: TaskScene, ctx: ApprovalContext): void {
  assertRevision(ctx.expectedRevision, scene.run.instance.revision);
  if (scene.run.instance.status !== 'running' || scene.task.status !== 'pending') {
    throw approvalError('CONFLICT', 'APPROVAL_TASK_CLOSED', '该任务已处理或流程已结束');
  }
  assertBusinessUnchanged(scene.run);
}

/** DEC-144：同意 / 不同意是出口动作，节点没有配置该出口动作即不可用（详情同样不公布）。 */
function assertExit(node: ApprovalNode, exit: NodeExit): void {
  if (!hasExit(node, exit)) {
    throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', `本节点没有「${EXIT_LABELS[exit]}」出口动作`);
  }
}

/**
 * 会签节点一人一票（F-003，P2-1）：转交、加签、管理员转交 / 改派不能派给本节点本次激活中已有任务的人——在办的，
 * 以及已同意 / 不同意的（否则同一人可以再投一票）。用户 ID 已在入口按数据库 UUID 语义规范化。
 */
async function assertNotNodeAssignee(tx: Tx, run: Run, node: ApprovalNode, task: TaskRow, userIds: readonly string[]) {
  if (!isCountersign(node)) return;
  const participants = nodeParticipantsOf(await loadTasks(tx, run.ctx.tenantId, run.instance.id), task);
  if (userIds.some((userId) => participants.has(userId))) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_ALREADY_NODE_ASSIGNEE', '该用户已在本节点审批（一人一票）');
  }
}

/** 驳回是节点开关（F-003 第二轮，`14` §12.2），单人与会签节点共用，加签人沿用原节点开关（`14` §11.4）。 */
function assertRejectEnabled(node: ApprovalNode): void {
  if (!rejectAllowed(node)) throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '本节点未开启驳回');
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
  const hidden = blindReviewFields(scene.run.snapshot.changedFields, viewable);
  if (!hidden.length) return null;
  const { run, task } = scene;
  const routing = await currentRouting(tx, run, task.nodeKey);
  const admin = (await exceptionAdminFor(tx, run, routing.subject, routing.facts)).userId;
  // C-非4：被拦的就是异常管理员本人（或接手人就是本人）时不再给自己建任务，由其转交给有权限者。
  if (task.isExceptionAdmin || admin === task.assigneeUserId) return blindRejection();
  await closeTask(tx, run.ctx, task.id, 'transferred');
  if (mergesSeat(run, await loadTasks(tx, run.ctx.tenantId, run.instance.id), task, admin)) {
    // 异常管理员已在本会签节点占着一席：这一席合并、不重复计票（P2-1），随后按一人一票重新结算。
    await mergeSeat(tx, run, task, admin, 'blind_review');
    await resettle(tx, run, task);
    run.events.push('approval.task.transferred');
    await persistRun(tx, run, 'approval.task.blind_review');
    return blindRejection();
  }
  const next = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: task.nodeKey,
    assigneeUserId: admin,
    origin: 'blind_review',
    status: 'pending',
    isExceptionAdmin: true,
    parentTaskId: task.id,
    activationId: task.activationId,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'blind_review_exception_admin',
    nodeKey: task.nodeKey,
    taskId: next,
    detail: { fromUserId: task.assigneeUserId, toUserId: admin, fields: hidden },
  });
  await notifyTodo(tx, run.ctx, run.instance, next, admin);
  // 清单 12 / A-2：盲审转交与普通转交一样写任务审计。
  await auditTask(
    tx,
    run,
    'approval.task.blind_review',
    { taskStatus: 'pending', assigneeUserId: task.assigneeUserId, newTaskId: null, newTaskStatus: null, fields: null },
    { taskStatus: 'transferred', assigneeUserId: admin, newTaskId: next, newTaskStatus: 'pending', fields: hidden },
  );
  run.events.push('approval.task.transferred');
  await persistRun(tx, run, 'approval.task.blind_review');
  return blindRejection();
}

function blindRejection(): Outcome {
  const message = '本单含您无权查看且已变更的字段，无法审批';
  return { status: 403, body: { error: { code: 'FORBIDDEN', message, details: { reason: 'APPROVAL_BLIND_REVIEW' } } } };
}

/** 清单 4：编辑后按新快照重新盲审；编辑带出了编辑人看不到的变化即整单回滚（编辑不生效，任务不动）。 */
function assertNotBlindAfterEdit(run: Run, viewable: ReadonlySet<string> | undefined): void {
  const hidden = blindReviewFields(run.snapshot.changedFields, viewable);
  if (hidden.length) {
    throw approvalError('FORBIDDEN', 'APPROVAL_BLIND_REVIEW', '编辑后本单出现您无权查看的变化字段，编辑未生效');
  }
}

/** DEC-105：审批类型不开放审批中编辑时（员工信息类），历史配置下的编辑一律拒绝，详情也不公布（F14）。 */
function assertApprovalEdit(run: Run): void {
  if (!APPROVAL_TYPES[run.snapshot.approvalType].approvalEdit) {
    throw approvalError('CONFLICT', 'APPROVAL_EDIT_UNSUPPORTED', '该类审批不支持审批中编辑，请驳回后由申请人修正');
  }
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
  run.snapshot = await adapter.snapshot(tx, run.ctx, run.instance.businessId);
  run.instance = { ...run.instance, businessVersion: run.snapshot.version };
  await appendLog(tx, run.ctx, run.instance, {
    event: 'edit',
    nodeKey: task.nodeKey,
    taskId: task.id,
    detail: { fields: Object.keys(fields) },
  });
  run.events.push('approval.instance.edited');
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
  assertExit(scene.node, 'approve');
  const blocked = await blindReview(tx, scene, viewable);
  if (blocked) return blocked;
  if (!isSubjectFill(scene)) await assertNotSelf(tx, scene.run, ctx.userId);
  const { run, task, node } = scene;
  await ADAPTERS[run.instance.businessType].beforeApprove?.(tx, ctx, run.instance.businessId, task.nodeKey);
  if (input.fields && Object.keys(input.fields).length) {
    assertApprovalEdit(run);
    if (node.editMode !== 'with_approve')
      throw approvalError('CONFLICT', 'APPROVAL_EDIT_MODE', '本节点不支持编辑与同意合一');
    assertNotAddSigner(await loadTasks(tx, ctx.tenantId, run.instance.id), task);
    await applyEdit(tx, scene, editableInput(node, input.fields, viewable));
    assertNotBlindAfterEdit(run, viewable);
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
  // DEC-095：加签人依次审批，前加签全部同意后回到原审批人，后加签全部完成才离开本节点；会签按流转规则结算。
  await continueAfterApproval(tx, run, task);
  run.events.push('approval.task.approved');
  await persistRun(tx, run, outcomeAction(run));
  return ok(run);
}

/** 本次命令之后实例所处的结果，写入实例审计的动作名。 */
const OUTCOME_ACTIONS: Readonly<Partial<Record<Run['instance']['status'], string>>> = {
  approved: 'approval.instance.complete',
  disapproved: 'approval.instance.disapprove',
  returned: 'approval.instance.return',
};

function outcomeAction(run: Run): string {
  return OUTCOME_ACTIONS[run.instance.status] ?? 'approval.instance.advance';
}

/**
 * 不同意（DEC-144）：出口动作，受流转规则约束。会签节点按规则结算（达到「不同意」的规则才沿不同意流转）；单人节点
 * 一人即流转。不同意连线连到结束（engine.followExit）：流程结束、业务不生效。会签节点的前加签人不计入流转规则
 * （DEC-152），不能点「不同意」。
 */
export async function disagreeTask(
  tx: Tx,
  ctx: ApprovalContext,
  input: DecisionInput,
  viewable: ReadonlySet<string> | undefined,
): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  assertExit(scene.node, 'disagree');
  const tasks = await loadTasks(tx, ctx.tenantId, scene.run.instance.id);
  if (isCountersign(scene.node) && !votesInTransition(tasks, scene.task)) {
    throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '前加签人不计入流转规则，只能同意或驳回');
  }
  const blocked = await blindReview(tx, scene, viewable);
  if (blocked) return blocked;
  if (!isSubjectFill(scene)) await assertNotSelf(tx, scene.run, ctx.userId);
  const { run, task, node } = scene;
  await ADAPTERS[run.instance.businessType].beforeApprove?.(tx, ctx, run.instance.businessId, task.nodeKey);
  await closeTask(tx, ctx, task.id, 'disagreed', input.comment);
  await appendLog(tx, ctx, run.instance, {
    event: 'disagree',
    nodeKey: task.nodeKey,
    taskId: task.id,
    adminSelfTransfer: task.adminSelfTransfer,
    detail: { comment: input.comment },
  });
  await auditTask(
    tx,
    run,
    'approval.task.disagree',
    { status: 'pending', comment: null },
    { status: 'disagreed', comment: input.comment },
  );
  await applyMessageRules(tx, ctx, run.instance, node, 'disagree', task);
  if (isCountersign(node)) await settleCountersign(tx, run, node, task);
  else await followExit(tx, run, node.key, 'disagree');
  run.events.push('approval.task.disagreed');
  await persistRun(tx, run, outcomeAction(run));
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
  assertRejectEnabled(scene.node);
  const blocked = await blindReview(tx, scene, viewable);
  if (blocked) return blocked;
  if (!isSubjectFill(scene)) await assertNotSelf(tx, scene.run, ctx.userId);
  const { run, task, node } = scene;
  await ADAPTERS[run.instance.businessType].beforeApprove?.(tx, ctx, run.instance.businessId, task.nodeKey);
  // DEC-059：节点开关「驳回意见必填」，出厂关闭。
  if (node.rejectCommentRequired && !input.comment?.trim()) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_COMMENT_REQUIRED', '本节点驳回时必须填写意见');
  }
  await closeTask(tx, ctx, task.id, 'rejected', input.comment);
  // DEC-144：驳回不进流转规则，会签节点任一人驳回即整单驳回，其余在办任务取消（与单人节点相同）。
  await returnInstance(tx, run, node.key);
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
  await persistRun(tx, run, 'approval.instance.return');
  return ok(run);
}

/** DEC-058：发起人或异动本人不得审批自己的单据；异常任务按 DEC-091 回避，不会落到本人名下。 */
/**
 * K-37（R3-T07）：发展计划员工填写自己计划的节点（审批人表达式 idp_employee 解析出的本人任务）不按“发起人 / 异动本人
 * 不能审批”拒绝——处理人就是计划员工本人（原站 W-114）。只对单人节点上由该表达式派给本人的任务生效。
 */
function isSubjectFill(scene: TaskScene): boolean {
  const { node, task } = scene;
  return (
    !isCountersign(node) &&
    node.approver === SUBJECT_FILL_APPROVER &&
    task.origin === 'resolved' &&
    APPROVAL_TYPES[scene.run.snapshot.approvalType].adapter === 'idp'
  );
}

async function assertNotSelf(tx: Tx, run: Run, userId: string): Promise<void> {
  const subjectUser = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  if (userId === run.instance.initiatorUserId || userId === subjectUser) {
    throw approvalError('CONFLICT', 'APPROVAL_SELF_REVIEW', '发起人或异动本人不能审批自己的单据');
  }
}

/**
 * 转交 / 加签 / 管理员转交改派的对象：具备审批资格（有效成员且离职未生效，第四轮 N2），且不是发起人或异动本人。
 */
async function assertReviewer(tx: Tx, run: Run, userId: string): Promise<void> {
  const scope = { tenantId: run.ctx.tenantId, asOf: tenantLocalDate(run.ctx.now, run.ctx.timezone) };
  if (!(await isEligibleApprover(tx, scope, userId))) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '目标用户已离职或不是本租户有效成员');
  }
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
  await assertNotNodeAssignee(tx, run, node, task, [input.userId]);
  await closeTask(tx, ctx, task.id, 'transferred', input.comment);
  const next = await delegate(tx, run, task, input.userId, 'transfer', { comment: input.comment });
  await auditDelegation(tx, run, 'approval.task.transfer', task, next, input, 'transferred');
  await applyMessageRules(tx, ctx, run.instance, node, 'transfer', { id: task.id, assigneeUserId: input.userId });
  await persistRun(tx, run, 'approval.instance.transfer');
  return ok(run);
}

export interface AddSignInput {
  readonly taskId: string;
  /** 加签人，按选择顺序依次审批（`14` §11.4）。 */
  readonly userIds: readonly string[];
  readonly type: AddSignType;
  readonly comment: string | null;
}

async function assertAddSigners(tx: Tx, run: Run, userIds: readonly string[], self: string): Promise<void> {
  if (new Set(userIds).size !== userIds.length)
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '加签人不能重复');
  if (userIds.includes(self)) throw approvalError('VALIDATION_FAILED', 'APPROVAL_USER_INVALID', '不能加签给自己');
  for (const userId of userIds) await assertReviewer(tx, run, userId);
}

/** 加签类型按节点类型（`14` §11.4）：单人节点前 / 后加签（DEC-095），会签节点前加签（DEC-152）与并加签（F-003）。 */
function assertAddSignType(node: ApprovalNode, type: AddSignType): void {
  const kind = nodeKindOf(node);
  if (NODE_ADD_SIGN_TYPES[kind].includes(type)) return;
  const message =
    kind === 'countersign' ? '会签审批节点只支持前加签、并加签' : '单人审批节点只支持前加签、后加签，不支持并加签';
  throw approvalError('CONFLICT', 'APPROVAL_ADD_SIGN_TYPE_UNSUPPORTED', message, { nodeKind: kind, type });
}

/**
 * DEC-095 加签（`14` §11.4）：前加签 = 本人任务挂起（add_signed），加签人依次先审、全部同意后回到本人；
 * 后加签 = 本人同意后加签人依次审批。第一位立即派待办，其余排队；任一加签人驳回即整单驳回（驳回本就退回整单，
 * 节点开了驳回时）。会签节点有前加签（DEC-152：按席位生效，前加签人不计入流转规则，回到原席位见 add-sign.ts）与
 * 并加签（F-003，见 parallelAddSign）；会签节点一人一票，加签人不能是本节点已有任务的人。
 */
export async function addSign(
  tx: Tx,
  ctx: ApprovalContext,
  input: AddSignInput,
  viewable: ReadonlySet<string> | undefined,
): Promise<Outcome> {
  const scene = await openTask(tx, ctx, input.taskId);
  assertOpen(scene, ctx);
  const { run, task, node } = scene;
  if (!node.actions.addSign) throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '本节点未开启加签');
  if (!addSignAllowed(await loadTasks(tx, ctx.tenantId, run.instance.id), task)) {
    throw approvalError('CONFLICT', 'APPROVAL_ADD_SIGN_NESTED', '加签人不能再加签，请同意或驳回后由原审批人处理');
  }
  assertAddSignType(node, input.type);
  await assertAddSigners(tx, run, input.userIds, ctx.userId);
  await assertNotNodeAssignee(tx, run, node, task, input.userIds);
  if (input.type === 'parallel') return parallelAddSign(tx, scene, input);
  if (input.type === 'after') {
    // 后加签包含本人的同意：照常做盲审与自审校验。
    const blocked = await blindReview(tx, scene, viewable);
    if (blocked) return blocked;
    await assertNotSelf(tx, run, ctx.userId);
  }
  const status = input.type === 'after' ? 'approved' : 'add_signed';
  await closeTask(tx, ctx, task.id, status, input.comment);
  if (input.type === 'after') {
    await appendLog(tx, ctx, run.instance, {
      event: 'approve',
      nodeKey: task.nodeKey,
      taskId: task.id,
      adminSelfTransfer: task.adminSelfTransfer,
      detail: { comment: input.comment, addSign: 'after' },
    });
    await applyMessageRules(tx, ctx, run.instance, node, 'approve', task);
  }
  const origin = input.type === 'after' ? 'add_sign_after' : 'add_sign_before';
  const [first, ...queued] = input.userIds as [string, ...string[]];
  const detail = { comment: input.comment, type: input.type, signers: input.userIds };
  const next = await delegate(tx, run, task, first, origin, detail);
  for (const userId of queued) {
    await insertTask(tx, ctx, run.instance.id, {
      round: run.instance.round,
      nodeKey: task.nodeKey,
      assigneeUserId: userId,
      origin,
      status: 'queued',
      parentTaskId: task.id,
      activationId: task.activationId,
    });
  }
  await auditDelegation(tx, run, 'approval.task.add_sign', task, next, { ...input, userId: first }, status);
  await persistRun(tx, run, 'approval.instance.add_sign');
  return ok(run);
}

/**
 * 并加签（F-003，`14` §11.4、DEC-144）：加签人与原审批人同时审批、无先后，各计一票、计入节点流转规则；原审批人的
 * 待办不动。一人一票：本节点已有任务（在办或已投票）的人不能再被加签（addSign 入口校验）。加签人的驳回沿用现有规则（任一人驳回即整单驳回），
 * 不能再加签（F5）、不能编辑表单（`14` §11.3）。
 */
async function parallelAddSign(tx: Tx, scene: TaskScene, input: AddSignInput): Promise<Outcome> {
  const { run, task } = scene;
  const detail = { comment: input.comment, type: input.type, signers: input.userIds };
  const created: string[] = [];
  for (const userId of input.userIds) created.push(await delegate(tx, run, task, userId, 'add_sign_parallel', detail));
  await auditApproval(tx, run.ctx, {
    action: 'approval.task.add_sign',
    objectType: 'approval-instance',
    objectId: run.instance.id,
    before: { taskStatus: 'pending', signers: [], newTaskIds: [], comment: null },
    after: { taskStatus: 'pending', signers: input.userIds, newTaskIds: created, comment: input.comment },
  });
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
  taskStatus: 'transferred' | 'approved' | 'add_signed',
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
  add_sign_before: 'approval.task.add_signed',
  add_sign_after: 'approval.task.add_signed',
  add_sign_parallel: 'approval.task.add_signed',
  admin_transfer: 'approval.task.transferred',
  admin_intervene: 'approval.task.reassigned',
} as const;

async function delegate(
  tx: Tx,
  run: Run,
  from: TaskRow,
  userId: string,
  origin: keyof typeof DELEGATION_EVENTS,
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
    activationId: from.activationId,
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
  assertApprovalEdit(scene.run);
  if (scene.node.editMode !== 'separate')
    throw approvalError('CONFLICT', 'APPROVAL_EDIT_MODE', '本节点没有独立的编辑按钮');
  assertNotAddSigner(await loadTasks(tx, ctx.tenantId, scene.run.instance.id), scene.task);
  await applyEdit(tx, scene, editableInput(scene.node, input.fields, viewable));
  assertNotBlindAfterEdit(scene.run, viewable);
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
  return urgeRun(tx, await openOwn(tx, ctx, instanceId));
}

/**
 * 业务管理员催办（R3-T07 IDP 流程干预“催办”，IDP-R16）：权限与范围由业务模块按其按钮与数据范围判定，这里不要求发起人；
 * 频率限制与通知同发起人催办。
 */
export async function urgeAsAdmin(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<Outcome> {
  return urgeRun(tx, await openRun(tx, ctx, instanceId));
}

async function urgeRun(tx: Tx, run: Run): Promise<Outcome> {
  const { ctx } = run;
  const instanceId = run.instance.id;
  if (run.instance.status !== 'running') throw approvalError('CONFLICT', 'APPROVAL_CLOSED', '流程不在审批中');
  const node = run.version.nodes.find((candidate) => candidate.key === run.instance.currentNodeKey);
  if (!node || !urgeOpen(run.instance, run.version)) {
    throw approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '当前节点不允许催办');
  }
  await assertUrgeInterval(tx, run);
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

/** 催办频率限制（PR #35 第二轮 C-非5）：同一实例 30 分钟内只能催办一次。 */
const URGE_INTERVAL_MS = 30 * 60 * 1000;

async function assertUrgeInterval(tx: Tx, run: Run): Promise<void> {
  const [last] = rowsOf<{ created_at: string }>(
    await tx.execute(sql`SELECT created_at FROM approval_instance_logs WHERE tenant_id=${run.ctx.tenantId}
      AND instance_id=${run.instance.id}::uuid AND event='urge' ORDER BY seq DESC LIMIT 1`),
  );
  if (last && run.ctx.now.getTime() - new Date(last.created_at).getTime() < URGE_INTERVAL_MS) {
    throw approvalError('CONFLICT', 'APPROVAL_URGE_TOO_FREQUENT', '催办过于频繁，请 30 分钟后再试');
  }
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
  // 业务入口撤回只跳过重复的业务状态迁移，不跳过“仅发起人”校验（清单 10）。
  const run = fromBusiness ? await openRun(tx, ctx, instanceId) : await openOwn(tx, ctx, instanceId);
  if (run.instance.initiatorUserId !== ctx.userId)
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有发起人可以撤回');
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

/**
 * 审批侧重提（DEC-103 / DEC-113）：只由原发起人进行（当前权限在路由层按首次提交复核）。驳回后重提；员工子集变更
 * 撤回后没有业务侧入口，也在这里沿原实例重提（F9）。任职申请一律经任职模块的“提交”重提。
 */
export async function resubmit(tx: Tx, ctx: ApprovalContext, instanceId: string, corrections?: Row): Promise<Outcome> {
  const run = await openOwn(tx, ctx, instanceId);
  const reopenable =
    run.instance.status === 'returned' ||
    (run.instance.status === 'withdrawn' && run.instance.businessType === 'personnel_change');
  if (!reopenable) throw approvalError('CONFLICT', 'APPROVAL_NOT_RETURNED', '只有被驳回或已撤回的申请可以重提');
  if (run.instance.businessType === 'contract') await ctx.recheckContractResubmit?.(tx, instanceId, corrections ?? {});
  // 业务单回到待审批、修正追加为新版本，并按完整载荷复核当前自助字段白名单（DEC-099 / DEC-113 / N1）。
  await ADAPTERS[run.instance.businessType].resubmit(tx, ctx, run.instance.businessId, corrections ?? {});
  // DEC-103：重提沿用原实例与原流程版本，不重新匹配。
  const saved = await startOrResume(tx, ctx, {
    businessType: run.instance.businessType,
    businessId: run.instance.businessId,
  });
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
  assertBusinessUnchanged(run);
  // DEC-092：管理员不得干预本人发起或本人为异动对象的实例，须由其他管理员处理。
  const subjectUser = await userOfPerson(tx, ctx.tenantId, run.snapshot.subjectEmployeeId);
  if (isOwnRequest(run.instance, subjectUser, ctx.userId)) {
    throw approvalError(
      'FORBIDDEN',
      'APPROVAL_ADMIN_SELF',
      '不能干预本人发起或本人为异动对象的审批，请由其他管理员处理',
    );
  }
  const intervene = input.kind !== 'transfer';
  if ((intervene || input.toUserId === ctx.userId) && !input.reason?.trim()) {
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_REASON_REQUIRED', '管理员干预或转交给自己时必须填写理由');
  }
  if (input.kind === 'jump') return adminJump(tx, run, input);
  const tasks = await loadTasks(tx, ctx.tenantId, run.instance.id);
  const task = tasks.find((t) => t.id === input.taskId);
  if (!task || task.status !== 'pending')
    throw approvalError('CONFLICT', 'APPROVAL_TASK_CLOSED', '只能转交待处理的任务');
  await assertReviewer(tx, run, input.toUserId!);
  await assertNotNodeAssignee(tx, run, run.version.nodes[nodeIndex(run, task.nodeKey)]!, task, [input.toUserId!]);
  if (intervene) startHistoryAfter(run, tasks);
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

/**
 * F7：流程干预、跳转之后，之前的节点不再算历史审批人（`14` §11.6，手册 120981507）。失效的同意保留在任务与审计中，
 * 只是不再参与相同 / 历史审批人自动处理。
 */
function startHistoryAfter(run: Run, tasks: readonly TaskRow[]): void {
  run.instance = { ...run.instance, historyFromSeq: (tasks.at(-1)?.seq ?? 0) + 1 };
}

async function adminJump(tx: Tx, run: Run, input: AdminInput): Promise<Outcome> {
  const index = nodeIndex(run, input.toNodeKey ?? '');
  await cancelPending(tx, run.ctx, run.instance.id);
  const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
  startHistoryAfter(run, tasks);
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
  await advanceFrom(tx, run, index, tasks);
  run.events.push('approval.instance.jumped');
  await persistRun(tx, run, 'approval.instance.admin');
  return ok(run);
}
