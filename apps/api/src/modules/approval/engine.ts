/**
 * 审批流转引擎：发起 / 重提 / 节点推进 / 结束。节点逐个激活：先按表达式解析审批人，再按 decideNode 处理
 * 审批人为空、自审、相同 / 历史相同审批人跳过；遇到需人工审批的节点即停下等待。
 * 实例只引用发起时的版本 ID（已发布版本只读），在途实例不受新版本影响（REQ-APV-001 R2/R3）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  avoidSelfExceptionAdmin,
  blindReviewFields,
  decideNode,
  isSelf,
  mayResubmit,
  previousNodeComparand,
  submitBlockers,
  tenantLocalDate,
  type ApprovalNode,
  type Candidate,
  type NodeDecision,
  type RoutingFacts,
} from '@italent/domain';
import { ADAPTERS, type BusinessSnapshot, type BusinessType } from './adapters.js';
import { approvalError, auditApproval, emitOutbox, type ApprovalContext, type Row } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import { candidates, conditionContext, evaluate, noProcessMessage, replicaMatch } from './matching.js';
import { applyMessageRules, notifyTodo } from './notifications.js';
import {
  directManagerOf,
  isActiveMember,
  memo,
  personOfUser,
  resolveCandidate,
  tenantAdminUser,
  userOfPerson,
  type RoutingSubject,
} from './resolver.js';
import {
  resumableInstanceOf,
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

/**
 * 锁序与业务入口一致：先按业务侧顺序锁员工 / 业务单，再锁实例（清单 11）；业务入口（提交、撤回、删除）
 * 也是先锁业务再经挂接端口锁实例，两条路径不会互相等待成环。
 */
export async function openRun(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<Run> {
  const peek = await loadInstance(tx, ctx.tenantId, instanceId);
  const adapter = ADAPTERS[peek.businessType];
  await adapter.lock(tx, ctx, peek.businessId);
  const instance = await loadInstance(tx, ctx.tenantId, instanceId, true);
  const version = await loadVersion(tx, ctx.tenantId, instance.versionId);
  const snapshot = await adapter.snapshot(tx, ctx, instance.businessId);
  return { ctx, before: instance, version, snapshot, instance, events: [] };
}

/** 审批人所读的载荷版本必须仍是业务单的当前版本，否则旧审批失效（清单 1）。 */
export function assertBusinessUnchanged(run: Run): void {
  if (run.snapshot.version !== run.instance.businessVersion) {
    throw approvalError('REVISION_CONFLICT', 'APPROVAL_BUSINESS_CHANGED', '单据已被修改，请刷新后重新审批');
  }
}

function instanceAudit(instance: InstanceRow): Row {
  const { status, currentNodeKey, returnedFromNodeKey, round, historyFromSeq, revision, versionId } = instance;
  return { status, currentNodeKey, returnedFromNodeKey, round, historyFromSeq, revision, versionId };
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

/** 一次推进内的路由查询缓存：长串自动跳过不逐个节点重复查组织负责人与账号（X-20）。 */
function routingSubject(run: Run): RoutingSubject {
  return {
    tenantId: run.ctx.tenantId,
    asOf: tenantLocalDate(run.ctx.now, run.ctx.timezone),
    initiatorUserId: run.instance.initiatorUserId,
    latestDepartmentId: run.snapshot.latestDepartmentId,
    recordDepartmentId: run.snapshot.recordDepartmentId,
    cache: new Map(),
  };
}

function routingFacts(run: Run, tasks: readonly TaskRow[], index: number, subjectUserId: string | null): RoutingFacts {
  // TODO(需取证 Q-M0-43，#39)：“历史节点”是否跨驳回重提的轮次未取证；首版只认本轮已同意的人。
  // F7：管理员干预 / 跳转后，边界之前的任务不再算历史（`14` §11.6）。自动「跳过」的节点处理人是系统（DEC-106），
  // 不计为任何人的同意。
  const history = tasks.filter((task) => task.round === run.instance.round && task.seq >= run.instance.historyFromSeq);
  const approvedBy = (task: TaskRow) => task.assigneeUserId !== null && task.status === 'approved';
  const previousKey = index > 0 ? run.version.nodes[index - 1]!.key : null;
  return {
    isFirstNode: index === 0,
    initiatorUserId: run.instance.initiatorUserId,
    subjectEmployeeId: run.snapshot.subjectEmployeeId,
    subjectUserId,
    exceptionAdminUserId: run.version.exceptionAdminUserId!,
    previousApproverUserId: previousNodeComparand(history.filter((task) => task.nodeKey === previousKey)),
    approvedUserIds: history.filter(approvedBy).map((task) => task.assigneeUserId!),
    chainUserIds: tasks
      .filter((task) => task.assigneeUserId !== null && task.origin !== 'self_skip')
      .map((task) => task.assigneeUserId!),
  };
}

/** 解析某节点的审批人并给出决策；候选人随任务留存，作为下一节点“与上一节点相同”的比较对象（DEC-114）。 */
async function decide(tx: Tx, subject: RoutingSubject, node: ApprovalNode, facts: RoutingFacts) {
  const candidate = await resolveCandidate(tx, subject, node.approver);
  const draft = decideNode(node, candidate, facts);
  if (draft.kind !== 'assign' || draft.selfSkippedUserId === null) return { candidate, decision: draft };
  return { candidate, decision: decideNode(node, candidate, facts, await directManagerOf(tx, subject, candidate)) };
}

/** 自动处理的触发机制（审批记录里区分“与上一节点相同 / 与历史节点相同”）。 */
const MECHANISMS = { same_skip: 'same', history_skip: 'history' } as const;

/**
 * 实际接手异常任务的人：流程上的异常管理员已停用时由租户管理员接管（DEC-098）；接手人恰为发起人或异动本人时
 * 回避给其直线经理，不可用即拒绝本次提交 / 操作并提示调整流程（DEC-091）。
 */
export async function exceptionAdminFor(
  tx: Tx,
  run: Run,
  subject: RoutingSubject,
  facts: RoutingFacts,
): Promise<{ userId: string; reason: string }> {
  const tenantId = run.ctx.tenantId;
  const configured = run.version.exceptionAdminUserId!;
  const userId = (await isActiveMember(tx, tenantId, configured)) ? configured : await tenantAdminUser(tx, tenantId);
  if (!userId) {
    throw approvalError('CONFLICT', 'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE', '异常管理员已停用且租户没有可接管的管理员');
  }
  const admin: Candidate = { userId, personId: await personOfUser(tx, tenantId, userId) };
  const manager = isSelf(admin, facts) ? await directManagerOf(tx, subject, admin) : undefined;
  const choice = avoidSelfExceptionAdmin(admin, facts, manager);
  if (choice.kind === 'unavailable') {
    // 提交预检与仿真共用 submitBlockers（F13）。
    throw approvalError('CONFLICT', 'APPROVAL_EXCEPTION_ADMIN_SELF', submitBlockers(choice)[0]!.message);
  }
  const takeover = userId === configured ? '' : '（原异常管理员已停用，由租户管理员接管）';
  return { userId: choice.userId, reason: choice.reason + takeover };
}

/** 按实例当前状态计算路由事实（盲审转异常管理员、提交前预检共用）。 */
export async function currentRouting(tx: Tx, run: Run, nodeKey: string | null) {
  const subject = routingSubject(run);
  const subjectUserId = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
  const index = nodeKey ? nodeIndex(run, nodeKey) : 0;
  return { subject, facts: routingFacts(run, tasks, index, subjectUserId) };
}

async function assign(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  decision: Extract<NodeDecision, { kind: 'assign' }>,
  routing: { subject: RoutingSubject; facts: RoutingFacts; candidateUserId: string | null },
) {
  const { ctx, instance } = run;
  if (decision.isExceptionAdmin) {
    const admin = await exceptionAdminFor(tx, run, routing.subject, routing.facts);
    decision = { ...decision, userId: admin.userId, reason: `${decision.reason}；${admin.reason}` };
  }
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
    candidateUserId: routing.candidateUserId,
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

/**
 * 从第 index 个节点起激活，直到出现待审批任务或流程结束。任务只读一次，本次推进新增的自动跳过任务在内存中追加，
 * 路由查询按推进缓存（X-20）。
 */
export async function advanceFrom(tx: Tx, run: Run, index: number, known?: readonly TaskRow[]): Promise<void> {
  const subject = routingSubject(run);
  const subjectUserId = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  const tasks = [...(known ?? (await loadTasks(tx, run.ctx.tenantId, run.instance.id)))];
  for (let i = index; i < run.version.nodes.length; i++) {
    const node = run.version.nodes[i]!;
    const facts = routingFacts(run, tasks, i, subjectUserId);
    const { candidate, decision } = await decide(tx, subject, node, facts);
    if (decision.kind === 'first_node_empty') {
      throw approvalError('CONFLICT', 'APPROVAL_FIRST_NODE_EMPTY', decision.reason, { nodeKey: node.key });
    }
    if (decision.kind === 'assign') {
      await assign(tx, run, node, decision, { subject, facts, candidateUserId: candidate.userId });
      run.instance = { ...run.instance, status: 'running', currentNodeKey: node.key };
      return;
    }
    if (await blockedAutoApproval(tx, run, node, decision, { subject, facts })) return;
    tasks.push(await autoProcess(tx, run, node, decision, tasks));
  }
  await complete(tx, run);
}

/**
 * DEC-106：自动「同意」记为该审批人同意，并与人工同意一样触发本节点的“同意”消息规则（X-14）；
 * 自动「跳过」沿同意路径流转，处理人记为系统（任务无审批人），审批记录里两者分别记为 auto_approve / skip。
 */
async function autoProcess(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  decision: Extract<NodeDecision, { kind: 'auto' }>,
  tasks: readonly TaskRow[],
): Promise<TaskRow> {
  const skip = decision.result === 'skip';
  const assigneeUserId = skip ? null : decision.userId;
  const status = skip ? 'skipped' : 'approved';
  const round = run.instance.round;
  const taskId = await insertTask(tx, run.ctx, run.instance.id, {
    round,
    nodeKey: node.key,
    assigneeUserId,
    candidateUserId: decision.userId,
    origin: decision.outcome,
    status,
  });
  const mechanism = MECHANISMS[decision.outcome];
  const detail = skip
    ? { mechanism, handler: '系统', candidateUserId: decision.userId, reason: decision.reason }
    : { mechanism, userId: decision.userId, reason: decision.reason };
  const event = skip ? 'skip' : 'auto_approve';
  await appendLog(tx, run.ctx, run.instance, { event, nodeKey: node.key, taskId, actorUserId: null, detail });
  if (!skip) await applyMessageRules(tx, run.ctx, run.instance, node, 'approve', { id: taskId, assigneeUserId });
  return {
    id: taskId,
    seq: (tasks.at(-1)?.seq ?? 0) + 1,
    round,
    nodeKey: node.key,
    assigneeUserId,
    candidateUserId: decision.userId,
    origin: decision.outcome,
    status,
    isExceptionAdmin: false,
    adminSelfTransfer: false,
    parentTaskId: null,
    comment: null,
    actedAt: run.ctx.now.toISOString(),
  };
}

/**
 * 清单 5：同人自动同意前按该审批人当前的字段权限做盲审；看不到变化字段即不自动同意，
 * 按 DEC-069 转异常管理员（未注入字段权限解析时按看不到处理）。
 * @returns 是否已改派异常管理员（流程停在本节点）
 */
async function blockedAutoApproval(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  decision: Extract<NodeDecision, { kind: 'auto' }>,
  routing: { subject: RoutingSubject; facts: RoutingFacts },
): Promise<boolean> {
  const fields = run.ctx.fields;
  const viewable = fields
    ? await memo(routing.subject, `viewable:${decision.userId}`, () =>
        fields.viewable(tx, decision.userId!, run.snapshot.fieldObjectCode),
      )
    : new Set<string>();
  const hidden = blindReviewFields(run.snapshot.changedFields, viewable);
  if (!hidden.length) return false;
  const admin = await exceptionAdminFor(tx, run, routing.subject, routing.facts);
  const taskId = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: node.key,
    assigneeUserId: admin.userId,
    candidateUserId: decision.userId,
    origin: 'blind_review',
    status: 'pending',
    isExceptionAdmin: true,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'blind_review_exception_admin',
    nodeKey: node.key,
    taskId,
    actorUserId: null,
    detail: { fromUserId: decision.userId, toUserId: admin.userId, fields: hidden, autoSkip: decision.outcome },
  });
  await notifyTodo(tx, run.ctx, run.instance, taskId, admin.userId);
  run.events.push('approval.task.transferred');
  run.instance = { ...run.instance, status: 'running', currentNodeKey: node.key };
  return true;
}

async function complete(tx: Tx, run: Run): Promise<void> {
  run.instance = { ...run.instance, status: 'approved', currentNodeKey: null, returnedFromNodeKey: null };
  await appendLog(tx, run.ctx, run.instance, { event: 'complete', actorUserId: null });
  await ADAPTERS[run.instance.businessType].approved(tx, run.ctx, run.instance.businessId);
  run.events.push('approval.instance.approved');
}

/** 节点上没有待审批或排队中的任务时推进到下一节点（加签要求同节点全部完成）。 */
export async function afterNodeApproved(tx: Tx, run: Run, nodeKey: string, known?: readonly TaskRow[]): Promise<void> {
  const tasks = known ?? (await loadTasks(tx, run.ctx.tenantId, run.instance.id));
  const open = (task: TaskRow) =>
    task.round === run.instance.round && task.nodeKey === nodeKey && ['pending', 'queued'].includes(task.status);
  if (tasks.some(open)) return;
  await advanceFrom(tx, run, nodeIndex(run, nodeKey) + 1, tasks);
}

export interface StartRequest {
  readonly businessType: BusinessType;
  readonly businessId: string;
}

/**
 * 提交审批：首次提交按类型匹配流程（DEC-017）；驳回或撤回后再提交一律沿用原实例与原流程版本，不重新匹配，
 * 也不再触发“流程发起”（DEC-103，`14` §11.8）。
 */
export async function startOrResume(tx: Tx, ctx: ApprovalContext, request: StartRequest): Promise<InstanceRow> {
  const latest = await resumableInstanceOf(tx, ctx.tenantId, request.businessType, request.businessId);
  if (latest?.status === 'running') throw approvalError('CONFLICT', 'APPROVAL_ALREADY_RUNNING', '该申请已在审批中');
  if (latest) return resume(tx, ctx, latest.id);
  const snapshot = await ADAPTERS[request.businessType].snapshot(tx, ctx, request.businessId);
  const matched = await matchProcess(tx, ctx, snapshot);
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
    detail: { processId: matched.processId, versionNo: matched.version.versionNo, processCode: snapshot.processCode },
  });
  await assertExceptionAdminAvailable(tx, run);
  await advanceFrom(tx, run, 0);
  return persistRun(tx, run, 'approval.instance.start', true);
}

async function matchProcess(tx: Tx, ctx: ApprovalContext, snapshot: BusinessSnapshot) {
  const type = snapshot.approvalType;
  const list = await candidates(tx, ctx.tenantId, {
    objectCode: APPROVAL_TYPES[type].objectCode,
    approvalType: type,
    scope: 'published',
  });
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const context = await conditionContext(tx, ctx.tenantId, asOf, type, snapshot.conditionValues);
  const matched = replicaMatch(evaluate(list, context), type);
  if (!matched) throw approvalError('CONFLICT', 'APPROVAL_PROCESS_NOT_MATCHED', noProcessMessage(type));
  return matched;
}

/** DEC-091：提交前预检异常管理员可用（本人回避后无人可接替即拒绝提交，不等到中途卡住）。 */
async function assertExceptionAdminAvailable(tx: Tx, run: Run): Promise<void> {
  const routing = await currentRouting(tx, run, null);
  await exceptionAdminFor(tx, run, routing.subject, routing.facts);
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
     initiator_user_id,process_code,title,business_version,status,created_at,updated_at)
    VALUES (${id},${ctx.tenantId},${matched.processId}::uuid,${matched.version.id}::uuid,${snapshot.approvalType},
      ${APPROVAL_TYPES[snapshot.approvalType].objectCode},${request.businessType},${request.businessId}::uuid,
      ${snapshot.subjectEmployeeId},${ctx.userId},${snapshot.processCode},${snapshot.title},${snapshot.version},
      'running',${ctx.now.toISOString()},${ctx.now.toISOString()})`);
  return loadInstance(tx, ctx.tenantId, id, true);
}

/**
 * DEC-103 重提：沿用原实例与其冻结版本。驳回后按驳回节点的「驳回后提交方式」（DEC-053）；撤回后从第一个节点
 * 重新审批。实例的发起人不可改（0029 触发器），只有原发起人能重提。
 */
export async function resume(tx: Tx, ctx: ApprovalContext, instanceId: string): Promise<InstanceRow> {
  const run = await openRun(tx, ctx, instanceId);
  const afterWithdraw = run.instance.status === 'withdrawn';
  if (run.instance.status !== 'returned' && !afterWithdraw)
    throw approvalError('CONFLICT', 'APPROVAL_NOT_RETURNED', '只有被驳回或已撤回的申请可以重提');
  if (!mayResubmit(run.instance.initiatorUserId, ctx.userId))
    throw approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有原发起人可以重新提交');
  const rejecting = afterWithdraw ? null : run.instance.returnedFromNodeKey;
  const toRejecting =
    rejecting !== null && run.version.nodes[nodeIndex(run, rejecting)]!.rejectResubmit === 'rejecting_node';
  run.instance = {
    ...run.instance,
    status: 'running',
    round: run.instance.round + 1,
    returnedFromNodeKey: null,
    businessVersion: run.snapshot.version,
  };
  run.events.push('approval.instance.resubmitted');
  await appendLog(tx, ctx, run.instance, {
    event: 'resubmit',
    detail: { toNodeKey: toRejecting ? rejecting : null, afterWithdraw },
  });
  await assertExceptionAdminAvailable(tx, run);
  await advanceFrom(tx, run, toRejecting ? nodeIndex(run, rejecting) : 0);
  return persistRun(tx, run, 'approval.instance.resubmit');
}
