/**
 * 审批流转引擎：发起 / 重提 / 节点推进 / 结束。节点逐个激活：先按表达式解析审批人，再按 decideNode 处理
 * 审批人为空、自审、相同 / 历史相同审批人跳过；遇到需人工审批的节点即停下等待。
 * 实例只引用发起时的版本 ID（已发布版本只读），在途实例不受新版本影响（REQ-APV-001 R2/R3）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  decideNode,
  tenantLocalDate,
  type ApprovalNode,
  type NodeDecision,
  type RoutingFacts,
} from '@italent/domain';
import { ADAPTERS, type BusinessSnapshot, type BusinessType } from './adapters.js';
import { approvalError, auditApproval, emitOutbox, type ApprovalContext, type Row } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import { candidates, conditionContext, evaluate, noProcessMessage, replicaMatch } from './matching.js';
import { applyMessageRules, notifyTodo } from './notifications.js';
import { directManagerOf, resolveCandidate, userOfPerson, type RoutingSubject } from './resolver.js';
import {
  activeInstanceOf,
  appendLog,
  insertTask,
  loadInstance,
  loadTasks,
  updateInstance,
  type InstanceRow,
  type TaskRow,
} from './store.js';

/** 一次命令内的流转现场：实例状态在内存中推进，命令结束时一次落库（revision 只加一）。 */
export interface Run {
  readonly ctx: ApprovalContext;
  readonly before: InstanceRow;
  readonly version: VersionView;
  /** 审批中编辑改写业务单后重新加载，后续节点按编辑后的部门解析审批人。 */
  snapshot: BusinessSnapshot;
  instance: InstanceRow;
  readonly events: string[];
}

export async function openRun(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<Run> {
  const instance = await loadInstance(tx, ctx.tenantId, instanceId, true);
  const version = await loadVersion(tx, ctx.tenantId, instance.versionId);
  const snapshot = await ADAPTERS[instance.businessType].snapshot(tx, ctx, instance.businessId, instance.processCode);
  return { ctx, before: instance, version, snapshot, instance, events: [] };
}

function instanceAudit(instance: InstanceRow): Row {
  const { status, currentNodeKey, returnedFromNodeKey, round, revision, versionId } = instance;
  return { status, currentNodeKey, returnedFromNodeKey, round, revision, versionId };
}

/** 落库实例状态 + 字段级审计 + outbox，与本命令的其他写入同事务。 */
export async function persistRun(tx: Tx, run: Run, action: string, created = false): Promise<InstanceRow> {
  const saved = await updateInstance(tx, run.ctx, run.before, run.instance);
  await auditApproval(tx, run.ctx, {
    action,
    objectType: 'approval-instance',
    objectId: saved.id,
    before: created ? null : instanceAudit(run.before),
    after: instanceAudit(saved),
  });
  for (const eventType of new Set(run.events)) {
    await emitOutbox(tx, run.ctx, {
      objectType: 'approval-instance',
      objectId: saved.id,
      eventType,
      revision: saved.revision,
    });
  }
  return saved;
}

export function nodeIndex(run: Run, key: string): number {
  const index = run.version.nodes.findIndex((node) => node.key === key);
  if (index < 0) throw approvalError('VALIDATION_FAILED', 'APPROVAL_NODE_UNKNOWN', '节点不存在');
  return index;
}

function routingSubject(run: Run): RoutingSubject {
  return {
    tenantId: run.ctx.tenantId,
    asOf: tenantLocalDate(run.ctx.now, run.ctx.timezone),
    initiatorUserId: run.instance.initiatorUserId,
    latestDepartmentId: run.snapshot.latestDepartmentId,
    recordDepartmentId: run.snapshot.recordDepartmentId,
  };
}

const APPROVING = new Set(['same_skip', 'history_skip']);

function routingFacts(run: Run, tasks: readonly TaskRow[], index: number, subjectUserId: string | null): RoutingFacts {
  const round = tasks.filter((task) => task.round === run.instance.round);
  const approvedBy = (task: TaskRow) =>
    task.assigneeUserId !== null &&
    (task.status === 'approved' || (task.status === 'skipped' && APPROVING.has(task.origin)));
  const previousKey = index > 0 ? run.version.nodes[index - 1]!.key : null;
  const previous = round.filter((task) => task.nodeKey === previousKey && approvedBy(task)).at(-1);
  return {
    isFirstNode: index === 0,
    initiatorUserId: run.instance.initiatorUserId,
    subjectEmployeeId: run.snapshot.subjectEmployeeId,
    subjectUserId,
    exceptionAdminUserId: run.version.exceptionAdminUserId!,
    previousApproverUserId: previous?.assigneeUserId ?? null,
    approvedUserIds: round.filter(approvedBy).map((task) => task.assigneeUserId!),
    chainUserIds: tasks
      .filter((task) => task.assigneeUserId !== null && task.origin !== 'self_skip')
      .map((task) => task.assigneeUserId!),
  };
}

/** 解析某节点的审批人并给出决策（运行与仿真共用）。 */
export async function decide(
  tx: Tx,
  subject: RoutingSubject,
  node: ApprovalNode,
  facts: RoutingFacts,
): Promise<NodeDecision> {
  const candidate = await resolveCandidate(tx, subject, node.approver);
  const draft = decideNode(node, candidate, facts);
  if (draft.kind !== 'assign' || draft.selfSkippedUserId === null) return draft;
  return decideNode(node, candidate, facts, await directManagerOf(tx, subject, candidate));
}

const AUTO_EVENTS: Record<string, string> = {
  same_skip: 'same_assignee_skip',
  history_skip: 'history_assignee_skip',
  no_assignee_skip: 'no_assignee_skip',
  no_assignee_approve: 'no_assignee_approve',
};

async function assign(tx: Tx, run: Run, node: ApprovalNode, decision: Extract<NodeDecision, { kind: 'assign' }>) {
  const { ctx, instance } = run;
  if (decision.selfSkippedUserId) {
    const skipped = await insertTask(tx, ctx, instance.id, {
      round: instance.round,
      nodeKey: node.key,
      assigneeUserId: decision.selfSkippedUserId,
      origin: 'self_skip',
      status: 'skipped',
    });
    await appendLog(tx, ctx, instance, {
      event: 'self_skip',
      nodeKey: node.key,
      taskId: skipped,
      actorUserId: null,
      detail: { userId: decision.selfSkippedUserId, countedAsApprove: false, reason: decision.reason },
    });
  }
  const taskId = await insertTask(tx, ctx, instance.id, {
    round: instance.round,
    nodeKey: node.key,
    assigneeUserId: decision.userId,
    origin: decision.origin,
    status: 'pending',
    isExceptionAdmin: decision.isExceptionAdmin,
  });
  const event =
    decision.origin === 'exception_admin' && !decision.selfSkippedUserId ? 'no_assignee_exception_admin' : 'assign';
  await appendLog(tx, ctx, instance, {
    event,
    nodeKey: node.key,
    taskId,
    actorUserId: null,
    detail: { assigneeUserId: decision.userId, origin: decision.origin, reason: decision.reason },
  });
  await notifyTodo(tx, ctx, instance, taskId, decision.userId);
  await applyMessageRules(tx, ctx, instance, node, 'arrive', { id: taskId, assigneeUserId: decision.userId });
}

/** 从第 index 个节点起激活，直到出现待审批任务或流程结束。 */
export async function advanceFrom(tx: Tx, run: Run, index: number): Promise<void> {
  const subject = routingSubject(run);
  const subjectUserId = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  for (let i = index; i < run.version.nodes.length; i++) {
    const node = run.version.nodes[i]!;
    const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
    const decision = await decide(tx, subject, node, routingFacts(run, tasks, i, subjectUserId));
    if (decision.kind === 'first_node_empty') {
      throw approvalError('CONFLICT', 'APPROVAL_FIRST_NODE_EMPTY', decision.reason, { nodeKey: node.key });
    }
    if (decision.kind === 'assign') {
      await assign(tx, run, node, decision);
      run.instance = { ...run.instance, status: 'running', currentNodeKey: node.key };
      return;
    }
    const taskId = await insertTask(tx, run.ctx, run.instance.id, {
      round: run.instance.round,
      nodeKey: node.key,
      assigneeUserId: decision.userId,
      origin: decision.outcome,
      status: 'skipped',
    });
    await appendLog(tx, run.ctx, run.instance, {
      event: AUTO_EVENTS[decision.outcome]!,
      nodeKey: node.key,
      taskId,
      actorUserId: null,
      detail: { userId: decision.userId, reason: decision.reason },
    });
  }
  await complete(tx, run);
}

async function complete(tx: Tx, run: Run): Promise<void> {
  run.instance = { ...run.instance, status: 'approved', currentNodeKey: null, returnedFromNodeKey: null };
  await appendLog(tx, run.ctx, run.instance, { event: 'complete', actorUserId: null });
  await ADAPTERS[run.instance.businessType].approved(tx, run.ctx, run.instance.businessId);
  run.events.push('approval.instance.approved');
}

/** 节点上没有待审批任务时推进到下一节点（加签要求同节点全部同意）。 */
export async function afterNodeApproved(tx: Tx, run: Run, nodeKey: string): Promise<void> {
  const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
  if (tasks.some((task) => task.round === run.instance.round && task.nodeKey === nodeKey && task.status === 'pending'))
    return;
  await advanceFrom(tx, run, nodeIndex(run, nodeKey) + 1);
}

export interface StartRequest {
  readonly businessType: BusinessType;
  readonly businessId: string;
  readonly processCode: string | null;
}

/** 提交审批：退回中的实例按驳回节点配置同单重提（DEC-053），否则按类型匹配新流程（DEC-017）。 */
export async function startOrResume(tx: Tx, ctx: ApprovalContext, request: StartRequest): Promise<InstanceRow> {
  const active = await activeInstanceOf(tx, ctx.tenantId, request.businessType, request.businessId);
  if (active?.status === 'running') throw approvalError('CONFLICT', 'APPROVAL_ALREADY_RUNNING', '该申请已在审批中');
  if (active) return resume(tx, ctx, active.id);
  const snapshot = await ADAPTERS[request.businessType].snapshot(tx, ctx, request.businessId, request.processCode);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const type = snapshot.approvalType;
  const list = await candidates(tx, ctx.tenantId, {
    objectCode: APPROVAL_TYPES[type].objectCode,
    approvalType: type,
    scope: 'published',
  });
  const context = await conditionContext(tx, ctx.tenantId, asOf, type, snapshot.conditionValues);
  const matched = replicaMatch(evaluate(list, context), type);
  if (!matched) throw approvalError('CONFLICT', 'APPROVAL_PROCESS_NOT_MATCHED', noProcessMessage(type));
  const instance = await insertInstance(tx, ctx, request, snapshot, matched);
  const run: Run = {
    ctx,
    before: instance,
    version: await loadVersion(tx, ctx.tenantId, matched.version.id),
    snapshot,
    instance,
    events: ['approval.instance.started'],
  };
  await appendLog(tx, ctx, instance, {
    event: 'start',
    detail: { processId: matched.processId, versionNo: matched.version.versionNo, processCode: request.processCode },
  });
  await advanceFrom(tx, run, 0);
  return persistRun(tx, run, 'approval.instance.start', true);
}

async function insertInstance(
  tx: Tx,
  ctx: ApprovalContext,
  request: StartRequest,
  snapshot: BusinessSnapshot,
  matched: { processId: string; version: { id: string } },
): Promise<InstanceRow> {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO approval_instances
    (id,tenant_id,process_id,version_id,approval_type,object_code,business_type,business_id,subject_employee_id,
     initiator_user_id,process_code,title,status,created_at,updated_at)
    VALUES (${id},${ctx.tenantId},${matched.processId}::uuid,${matched.version.id}::uuid,${snapshot.approvalType},
      ${APPROVAL_TYPES[snapshot.approvalType].objectCode},${request.businessType},${request.businessId}::uuid,
      ${snapshot.subjectEmployeeId},${ctx.userId},${request.processCode},${snapshot.title},'running',
      ${ctx.now.toISOString()},${ctx.now.toISOString()})`);
  return loadInstance(tx, ctx.tenantId, id, true);
}

export async function resume(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<InstanceRow> {
  const run = await openRun(tx, ctx, instanceId);
  if (run.instance.status !== 'returned')
    throw approvalError('CONFLICT', 'APPROVAL_NOT_RETURNED', '只有被驳回的申请可以重提');
  if (run.instance.initiatorUserId !== ctx.userId)
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有发起人可以重提');
  const rejecting = run.instance.returnedFromNodeKey;
  const toRejecting =
    rejecting !== null && run.version.nodes[nodeIndex(run, rejecting)]!.rejectResubmit === 'rejecting_node';
  run.instance = { ...run.instance, status: 'running', round: run.instance.round + 1, returnedFromNodeKey: null };
  run.events.push('approval.instance.resubmitted');
  await appendLog(tx, ctx, run.instance, { event: 'resubmit', detail: { toNodeKey: toRejecting ? rejecting : null } });
  await advanceFrom(tx, run, toRejecting ? nodeIndex(run, rejecting) : 0);
  return persistRun(tx, run, 'approval.instance.resubmit');
}
