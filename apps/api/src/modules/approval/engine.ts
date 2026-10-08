/**
 * 审批流转引擎：发起 / 重提 / 节点推进 / 结束。节点逐个激活：先按表达式解析审批人，再按 decideNode 处理
 * 审批人为空、自审、相同 / 历史相同审批人跳过；遇到需人工审批的节点即停下等待。
 * 会签节点（F-003）逐人解析与处理，按流转规则判定进入节点时是否已可流转（DEC-144）；成员处理后的结算见 countersign.ts。
 * 节点沿出口动作的连线流转（followExit）：「同意」进入下一节点，「不同意」连到结束（DEC-144，`14` §12.2）。
 * 实例只引用发起时的版本 ID（已发布版本只读），在途实例不受新版本影响（REQ-APV-001 R2/R3）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  conditionViolations,
  avoidSelfExceptionAdmin,
  blindReviewFields,
  countersignEndedReason,
  countersignOutcome,
  decideNode,
  effectiveHistory,
  EXIT_TARGETS,
  exitRulesOf,
  isCountersign,
  isSelf,
  mayResubmit,
  nodeExits,
  previousNodeComparand,
  STALLED_COUNTERSIGN_HANDLING,
  SUBJECT_FILL_APPROVER,
  submitBlockers,
  tenantLocalDate,
  type ApprovalNode,
  type ApproverExpression,
  type Candidate,
  type CountersignApprovalNode,
  type NodeDecision,
  type NodeExit,
  type RoutingFacts,
  type SingleApprovalNode,
} from '@italent/domain';
import { ADAPTERS, type BusinessSnapshot, type BusinessType } from './adapters.js';
import { viewableWithForeign } from './foreign-fields.js';
import { approvalError, auditApproval, emitOutbox, type ApprovalContext, type Row } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import { candidates, conditionContext, evaluate, noProcessMessage, replicaMatch } from './matching.js';
import { applyMessageRules, notifyTodo } from './notifications.js';
import {
  directManagerOf,
  isAssignable,
  memo,
  personOfUser,
  resolveCandidate,
  tenantAdminTakeover,
  userOfPerson,
  type RoutingSubject,
} from './resolver.js';
import {
  resumableInstanceOf,
  appendLog,
  cancelPending,
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
 * R4-2 / R5-1：操作人本人在入口试取派单闸（isAssignable）——正在停用或已停用即拒绝本次操作，从不等待；取到之后，
 * 他的停用须等本次操作结束才能关闸、开始接管，本次操作派给他本人的待办随后被接管。系统接管（DEC-123，操作人是
 * 平台方）不做此检查。
 */
async function assertActorUsable(tx: Tx, ctx: ApprovalContext): Promise<void> {
  if (ctx.actorUserId !== undefined) return;
  if (!(await isAssignable(tx, ctx.tenantId, ctx.userId))) {
    throw approvalError('CONFLICT', 'APPROVAL_CONCURRENT_CONFLICT', '账号状态正在变更或已停用，请稍后重试');
  }
}

/**
 * 锁序与业务入口一致：先按业务侧顺序锁员工 / 业务单，再锁实例（清单 11）；业务入口（提交、撤回、删除）
 * 也是先锁业务再经挂接端口锁实例，两条路径不会互相等待成环。派单闸只试取、不排队（R4-2 / R5-1）。
 */
export async function openRun(tx: Tx, ctx: ApprovalContext, instanceId: string, sourceOnly = false): Promise<Run> {
  await assertActorUsable(tx, ctx);
  const peek = await loadInstance(tx, ctx.tenantId, instanceId);
  const adapter = ADAPTERS[peek.businessType];
  await adapter.lock(tx, ctx, peek.businessId, sourceOnly);
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
    subjectEmployeeId: run.snapshot.subjectEmployeeId,
    latestDepartmentId: run.snapshot.latestDepartmentId,
    recordDepartmentId: run.snapshot.recordDepartmentId,
    tutorEmployeeId: run.snapshot.tutorEmployeeId ?? null,
    cache: new Map(),
  };
}

function routingFacts(run: Run, tasks: readonly TaskRow[], index: number, subjectUserId: string | null): RoutingFacts {
  // DEC-124 / F7：只认本轮、有效历史边界之后的任务（policies.effectiveHistory，暂定待 Q-M0-43）。
  // 自动「跳过」的节点处理人是系统（DEC-106），不计为任何人的同意。
  const history = effectiveHistory(tasks, run.instance);
  const approvedBy = (task: TaskRow) => task.assigneeUserId !== null && task.status === 'approved';
  const previousKey = index > 0 ? run.version.nodes[index - 1]!.key : null;
  return {
    isFirstNode: index === 0,
    initiatorUserId: run.instance.initiatorUserId,
    subjectEmployeeId: run.snapshot.subjectEmployeeId,
    subjectUserId,
    exceptionAdminUserId: run.version.exceptionAdminUserId!,
    previousApproverUserIds: previousNodeComparand(history.filter((task) => task.nodeKey === previousKey)),
    approvedUserIds: history.filter(approvedBy).map((task) => task.assigneeUserId!),
    chainUserIds: tasks
      .filter((task) => task.assigneeUserId !== null && task.origin !== 'self_skip')
      .map((task) => task.assigneeUserId!),
  };
}

/**
 * 解析一个审批人表达式并给出决策；候选人随任务留存，作为下一节点“与上一节点相同”的比较对象（DEC-114）。
 * 会签节点对每个表达式各调用一次（逐人生效，F-003）。
 */
async function decide(
  tx: Tx,
  subject: RoutingSubject,
  node: ApprovalNode,
  expression: ApproverExpression,
  facts: RoutingFacts,
) {
  const candidate = await resolveCandidate(tx, subject, expression);
  // K-37：员工填写自己计划的节点不按自审回避（处理人就是计划员工本人，也是发起人）
  if (expression === SUBJECT_FILL_APPROVER)
    return { candidate, decision: decideNode(node, candidate, fillFacts(facts)) };
  const draft = decideNode(node, candidate, facts);
  if (draft.kind !== 'assign' || draft.selfSkippedUserId === null) return { candidate, decision: draft };
  return { candidate, decision: decideNode(node, candidate, facts, await directManagerOf(tx, subject, candidate)) };
}

/** 填写节点的路由事实：不把员工本人当作发起人或异动本人（K-37，只用于 idp_employee 解析出的人）。 */
const fillFacts = (facts: RoutingFacts): RoutingFacts => ({
  ...facts,
  initiatorUserId: '',
  subjectEmployeeId: null,
  subjectUserId: null,
});

/** 自动处理的触发机制（审批记录里区分“与上一节点相同 / 与历史节点相同”）。 */
const MECHANISMS = { same_skip: 'same', history_skip: 'history' } as const;

/**
 * 实际接手异常任务的人：流程上的异常管理员不可用（已停用、正在停用）时由租户管理员接管（DEC-098，回退人同样复核
 * 审批资格，R4-4）；接手人恰为发起人或异动本人时回避给其直线经理，不可用即拒绝本次提交 / 操作并提示调整流程（DEC-091）。
 */
export async function exceptionAdminFor(
  tx: Tx,
  run: Run,
  subject: RoutingSubject,
  facts: RoutingFacts,
): Promise<{ userId: string; reason: string }> {
  const tenantId = run.ctx.tenantId;
  const configured = run.version.exceptionAdminUserId!;
  if (!(await isAssignable(tx, tenantId, configured))) {
    const takeover = await tenantAdminTakeover(tx, subject, facts);
    if (!takeover) {
      throw approvalError(
        'CONFLICT',
        'APPROVAL_EXCEPTION_ADMIN_UNAVAILABLE',
        '异常管理员已停用且租户没有可接管的管理员',
      );
    }
    if (takeover.kind === 'unavailable') {
      throw approvalError('CONFLICT', 'APPROVAL_EXCEPTION_ADMIN_SELF', submitBlockers(takeover)[0]!.message);
    }
    return { userId: takeover.userId, reason: `${takeover.reason}（原异常管理员已停用，由租户管理员接管）` };
  }
  const admin: Candidate = { userId: configured, personId: await personOfUser(tx, tenantId, configured) };
  const manager = isSelf(admin, facts) ? await directManagerOf(tx, subject, admin) : undefined;
  const choice = avoidSelfExceptionAdmin(admin, facts, manager);
  if (choice.kind === 'unavailable') {
    // 提交预检与仿真共用 submitBlockers（F13）。
    throw approvalError('CONFLICT', 'APPROVAL_EXCEPTION_ADMIN_SELF', submitBlockers(choice)[0]!.message);
  }
  return { userId: choice.userId, reason: choice.reason };
}

/** 按实例当前状态计算路由事实（盲审转异常管理员、提交前预检共用）。 */
export async function currentRouting(tx: Tx, run: Run, nodeKey: string | null) {
  const subject = routingSubject(run);
  const subjectUserId = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  const tasks = await loadTasks(tx, run.ctx.tenantId, run.instance.id);
  const index = nodeKey ? nodeIndex(run, nodeKey) : 0;
  return { subject, facts: routingFacts(run, tasks, index, subjectUserId) };
}

interface Entry {
  readonly subject: RoutingSubject;
  readonly facts: RoutingFacts;
  /** 节点的本次激活（F-003）：本次进入节点产生的任务共用。 */
  readonly activationId: string;
}

/** 落定需人工审批的决策：异常管理员按实际接手人（DEC-098 / DEC-091）改写，其余原样返回。 */
async function settleAssignee(
  tx: Tx,
  run: Run,
  decision: Extract<NodeDecision, { kind: 'assign' }>,
  entry: Entry,
): Promise<Extract<NodeDecision, { kind: 'assign' }>> {
  if (!decision.isExceptionAdmin) return decision;
  const admin = await exceptionAdminFor(tx, run, entry.subject, entry.facts);
  return { ...decision, userId: admin.userId, reason: `${decision.reason}；${admin.reason}` };
}

/** 被自审跳过的人只留痕（不计同意，C-非3）。 */
async function recordSelfSkip(tx: Tx, run: Run, nodeKey: string, decision: NodeDecision, activationId: string) {
  if (decision.kind !== 'assign' || !decision.selfSkippedUserId) return;
  const { ctx, instance } = run;
  const skipped = await insertTask(tx, ctx, instance.id, {
    round: instance.round,
    nodeKey,
    assigneeUserId: decision.selfSkippedUserId,
    origin: 'self_skip',
    status: 'skipped',
    activationId,
  });
  await appendLog(tx, ctx, instance, {
    event: 'self_skip',
    nodeKey,
    taskId: skipped,
    actorUserId: null,
    detail: { userId: decision.selfSkippedUserId, countedAsApprove: false, reason: decision.reason },
  });
}

async function assign(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  pending: Extract<NodeDecision, { kind: 'assign' }>,
  routing: Entry & { candidateUserId: string | null },
) {
  const decision = await settleAssignee(tx, run, pending, routing);
  await recordSelfSkip(tx, run, node.key, decision, routing.activationId);
  await insertAssigned(tx, run, node, decision, routing);
}

/** 写入已落定接手人的待办，并发审批记录、待办通知与“到达”消息。 */
async function insertAssigned(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  decision: Extract<NodeDecision, { kind: 'assign' }>,
  routing: { candidateUserId: string | null; mergedCandidateUserIds?: readonly string[]; activationId: string },
) {
  const taskId = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: node.key,
    assigneeUserId: decision.userId,
    candidateUserId: routing.candidateUserId,
    mergedCandidateUserIds: routing.mergedCandidateUserIds ?? [],
    origin: decision.origin,
    status: 'pending',
    isExceptionAdmin: decision.isExceptionAdmin,
    activationId: routing.activationId,
  });
  await announceAssignment(tx, run, node, decision, taskId);
}

/** 新待办的审批记录、待办通知与“到达”消息。 */
async function announceAssignment(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  decision: Extract<NodeDecision, { kind: 'assign' }>,
  taskId: string,
) {
  const { ctx, instance } = run;
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
 * 从第 index 个节点起激活，直到出现待审批任务或流程结束。任务只读一次，本次推进新增的自动处理任务在内存中追加，
 * 路由查询按推进缓存（X-20）。每次进入节点都取新的激活编号（F-003）。
 */
export async function advanceFrom(tx: Tx, run: Run, index: number, known?: readonly TaskRow[]): Promise<void> {
  const subject = routingSubject(run);
  const subjectUserId = await userOfPerson(tx, run.ctx.tenantId, run.snapshot.subjectEmployeeId);
  const tasks = [...(known ?? (await loadTasks(tx, run.ctx.tenantId, run.instance.id)))];
  for (let i = index; i < run.version.nodes.length; i++) {
    const node = run.version.nodes[i]!;
    const entry: Entry = { subject, facts: routingFacts(run, tasks, i, subjectUserId), activationId: randomUUID() };
    const result = isCountersign(node)
      ? await enterCountersign(tx, run, node, entry, tasks)
      : await enterSingle(tx, run, node, entry, tasks);
    if (result !== 'next') return;
  }
  await complete(tx, run);
}

/** 进入节点的结果：继续下一节点 / 停在本节点等待人工处理 / 实例已退回发起人。 */
type EntryResult = 'next' | 'stay' | 'returned';

function firstNodeEmpty(nodeKey: string, decision: { readonly reason: string }, extra: Row = {}) {
  return approvalError('CONFLICT', 'APPROVAL_FIRST_NODE_EMPTY', decision.reason, { nodeKey, ...extra });
}

/** 单人审批节点：需人工审批即停下；相同 / 历史相同审批人自动处理后继续下一节点。 */
async function enterSingle(
  tx: Tx,
  run: Run,
  node: SingleApprovalNode,
  entry: Entry,
  tasks: TaskRow[],
): Promise<EntryResult> {
  const { candidate, decision } = await decide(tx, entry.subject, node, node.approver, entry.facts);
  if (decision.kind === 'first_node_empty') throw firstNodeEmpty(node.key, decision);
  if (decision.kind === 'assign') {
    await assign(tx, run, node, decision, { ...entry, candidateUserId: candidate.userId });
    run.instance = { ...run.instance, status: 'running', currentNodeKey: node.key };
    return 'stay';
  }
  const hidden = await hiddenForAuto(tx, run, entry, decision.userId!);
  if (hidden.length) {
    await blindReviewSeat(
      tx,
      run,
      node,
      { decision, hidden, admin: await exceptionAdminFor(tx, run, entry.subject, entry.facts) },
      entry,
    );
    run.instance = { ...run.instance, status: 'running', currentNodeKey: node.key };
    return 'stay';
  }
  tasks.push(await autoProcess(tx, run, node, decision, tasks, entry.activationId));
  return 'next';
}

/**
 * 会签节点的一席（F-003）：一个审批人表达式逐人解析后的处理方式。同一人只占一席（两个表达式解析为同一人，或落到
 * 同一个接手人时按一人计）。
 */
type Seat =
  | {
      readonly kind: 'manual';
      readonly decision: Extract<NodeDecision, { kind: 'assign' }>;
      readonly candidateUserId: string | null;
    }
  | { readonly kind: 'auto'; readonly decision: Extract<NodeDecision, { kind: 'auto' }> }
  | { readonly kind: 'blind'; readonly blind: BlindReview };

/** 自动同意被盲审拦下（清单 5 / DEC-069）：转异常管理员人工处理。 */
interface BlindReview {
  readonly decision: Extract<NodeDecision, { kind: 'auto' }>;
  readonly hidden: readonly string[];
  readonly admin: { readonly userId: string; readonly reason: string };
}

const seatUser = (seat: Seat) =>
  seat.kind === 'manual'
    ? seat.decision.userId
    : seat.kind === 'auto'
      ? seat.decision.userId!
      : seat.blind.admin.userId;

/** 一席及合并进来的其他候选人（两个表达式落到同一接手人时，后者的候选人随这一席留存）。 */
interface SeatEntry {
  readonly seat: Seat;
  readonly mergedCandidateUserIds: string[];
}

/**
 * 逐人解析会签审批人（F-003）：审批人为空（DEC-054 / 098）、自审（DEC-068）、相同 / 历史相同审批人自动同意（`14`
 * §11.6，会签只有「同意」，DEC-106）都按人处理；首节点任一人为空即拒绝提交。被自审跳过的人另行留痕，即使其接替人
 * 与其他席位重合、该席被合并；被合并那一席的候选人留在保留的这一席上，下一节点按全部候选人比较（DEC-114，P2-4）。
 */
async function countersignSeats(tx: Tx, run: Run, node: CountersignApprovalNode, entry: Entry) {
  const seats: SeatEntry[] = [];
  const selfSkips: NodeDecision[] = [];
  const candidates = new Set<string>();
  for (const expression of node.approvers) {
    const { candidate, decision } = await decide(tx, entry.subject, node, expression, entry.facts);
    if (decision.kind === 'first_node_empty') throw firstNodeEmpty(node.key, decision, { approver: expression });
    if (candidate.userId !== null && candidates.has(candidate.userId)) continue;
    if (candidate.userId !== null) candidates.add(candidate.userId);
    if (decision.kind === 'assign' && decision.selfSkippedUserId) selfSkips.push(decision);
    const seat = await seatOf(tx, run, decision, candidate.userId, entry);
    const same = seats.find((other) => seatUser(other.seat) === seatUser(seat));
    if (!same) seats.push({ seat, mergedCandidateUserIds: [] });
    else if (candidate.userId !== null) same.mergedCandidateUserIds.push(candidate.userId);
  }
  return { seats, selfSkips };
}

async function seatOf(
  tx: Tx,
  run: Run,
  decision: Exclude<NodeDecision, { kind: 'first_node_empty' }>,
  candidateUserId: string | null,
  entry: Entry,
): Promise<Seat> {
  if (decision.kind === 'assign') {
    return { kind: 'manual', decision: await settleAssignee(tx, run, decision, entry), candidateUserId };
  }
  const hidden = await hiddenForAuto(tx, run, entry, decision.userId!);
  if (!hidden.length) return { kind: 'auto', decision };
  return {
    kind: 'blind',
    blind: { decision, hidden, admin: await exceptionAdminFor(tx, run, entry.subject, entry.facts) },
  };
}

/**
 * 进入会签节点：全部审批人同时收到待办。自动同意计入流转规则（DEC-144），进入节点时就达到规则的直接流转，其余席位
 * 的任务记为“因节点已通过而结束”（暂定，Q-M0-57），不发待办；规则已无法达成（全是自动同意仍不够）按暂定口径退回。
 */
async function enterCountersign(
  tx: Tx,
  run: Run,
  node: CountersignApprovalNode,
  entry: Entry,
  tasks: TaskRow[],
): Promise<EntryResult> {
  const { seats, selfSkips } = await countersignSeats(tx, run, node, entry);
  for (const skipped of selfSkips) await recordSelfSkip(tx, run, node.key, skipped, entry.activationId);
  const rules = exitRulesOf(node.transitionRule, nodeExits(node));
  const outcome = countersignOutcome(
    rules,
    seats.map(({ seat }) => (seat.kind === 'auto' ? 'approve' : 'open')),
  );
  const ended = outcome.kind === 'flow' ? countersignEndedReason(outcome.exit) : null;
  for (const seat of seats) await writeSeat(tx, run, node, seat, entry, tasks, ended);
  if (outcome.kind === 'pending') {
    run.instance = { ...run.instance, status: 'running', currentNodeKey: node.key };
    return 'stay';
  }
  tasks.splice(0, tasks.length, ...(await loadTasks(tx, run.ctx.tenantId, run.instance.id)));
  if (outcome.kind === 'flow') {
    await appendLog(tx, run.ctx, run.instance, {
      event: 'countersign_flow',
      nodeKey: node.key,
      actorUserId: null,
      detail: { exit: outcome.exit, count: outcome.count, threshold: outcome.threshold, onEntry: true },
    });
    return 'next';
  }
  await appendLog(tx, run.ctx, run.instance, {
    event: 'countersign_stalled',
    nodeKey: node.key,
    actorUserId: null,
    detail: { handling: STALLED_COUNTERSIGN_HANDLING, onEntry: true },
  });
  await returnInstance(tx, run, node.key);
  return 'returned';
}

/** 写入一席的任务：自动同意直接记同意；人工审批派待办，或在节点进入即流转时记为已结束（不发待办）。 */
async function writeSeat(
  tx: Tx,
  run: Run,
  node: CountersignApprovalNode,
  { seat, mergedCandidateUserIds }: SeatEntry,
  entry: Entry,
  tasks: readonly TaskRow[],
  endedReason: string | null,
) {
  if (seat.kind === 'auto') {
    await autoProcess(tx, run, node, seat.decision, tasks, entry.activationId, mergedCandidateUserIds);
    return;
  }
  if (seat.kind === 'blind') {
    await blindReviewSeat(tx, run, node, seat.blind, entry, endedReason, mergedCandidateUserIds);
    return;
  }
  const candidateUserId = seat.candidateUserId;
  if (!endedReason) {
    await insertAssigned(tx, run, node, seat.decision, { ...entry, candidateUserId, mergedCandidateUserIds });
    return;
  }
  const taskId = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: node.key,
    assigneeUserId: seat.decision.userId,
    candidateUserId,
    mergedCandidateUserIds,
    origin: seat.decision.origin,
    status: 'ended',
    isExceptionAdmin: seat.decision.isExceptionAdmin,
    activationId: entry.activationId,
  });
  await logEnded(tx, run, node.key, taskId, seat.decision.userId, endedReason);
}

/** 会签任务因节点已流转而结束的审批记录（暂定，Q-M0-57）。 */
export async function logEnded(
  tx: Tx,
  run: Run,
  nodeKey: string,
  taskId: string,
  userId: string | null,
  reason: string,
) {
  await appendLog(tx, run.ctx, run.instance, {
    event: 'countersign_end',
    nodeKey,
    taskId,
    actorUserId: null,
    detail: { userId, reason },
  });
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
  activationId: string,
  mergedCandidateUserIds: readonly string[] = [],
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
    mergedCandidateUserIds,
    origin: decision.outcome,
    status,
    activationId,
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
    mergedCandidateUserIds,
    origin: decision.outcome,
    status,
    isExceptionAdmin: false,
    adminSelfTransfer: false,
    parentTaskId: null,
    activationId,
    comment: null,
    actedAt: run.ctx.now.toISOString(),
  };
}

/**
 * 清单 5：同人自动同意前按该审批人当前的字段权限做盲审；看不到变化字段即不自动同意，
 * 按 DEC-069 转异常管理员（未注入字段权限解析时按看不到处理）。
 * @returns 该审批人看不到的变化字段
 */
async function hiddenForAuto(tx: Tx, run: Run, entry: Entry, userId: string): Promise<string[]> {
  const fields = run.ctx.fields;
  const base = fields
    ? await memo(entry.subject, `viewable:${userId}`, () => fields.viewable(tx, userId, run.snapshot.fieldObjectCode))
    : new Set<string>();
  const foreign = fields?.foreignVisible;
  const viewable = await viewableWithForeign(
    run.snapshot,
    base,
    foreign ? (field) => foreign.call(fields, tx, userId, field) : undefined,
  );
  return blindReviewFields(run.snapshot.changedFields, viewable);
}

/** 自动同意被盲审拦下：给异常管理员派待办（会签节点进入即流转时记为已结束）。 */
async function blindReviewSeat(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  blind: BlindReview,
  entry: Entry,
  endedReason: string | null = null,
  mergedCandidateUserIds: readonly string[] = [],
) {
  const { decision, hidden, admin } = blind;
  const taskId = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: node.key,
    assigneeUserId: admin.userId,
    candidateUserId: decision.userId,
    mergedCandidateUserIds,
    origin: 'blind_review',
    status: endedReason ? 'ended' : 'pending',
    isExceptionAdmin: true,
    activationId: entry.activationId,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'blind_review_exception_admin',
    nodeKey: node.key,
    taskId,
    actorUserId: null,
    detail: { fromUserId: decision.userId, toUserId: admin.userId, fields: hidden, autoSkip: decision.outcome },
  });
  if (endedReason) return logEnded(tx, run, node.key, taskId, admin.userId, endedReason);
  await notifyTodo(tx, run.ctx, run.instance, taskId, admin.userId);
  run.events.push('approval.task.transferred');
}

/**
 * 沿出口动作的连线流转（DEC-144，types.EXIT_TARGETS）：「同意」进入下一节点；「不同意」连到结束。单人节点点了即流转，
 * 会签节点达到该动作的规则才流转（countersign.settleCountersign）。
 */
export async function followExit(tx: Tx, run: Run, nodeKey: string, exit: NodeExit): Promise<void> {
  if (EXIT_TARGETS[exit] === 'next') return advanceFrom(tx, run, nodeIndex(run, nodeKey) + 1);
  await endDisapproved(tx, run, nodeKey);
}

/**
 * 沿「不同意」连线流转到结束（`14` §12.2：本租户不同意连线都连到结束）：在办任务取消，流程结束、业务不生效，业务单
 * 办结为“未通过”，不进入可修改重提的退回（与驳回不同）。
 */
async function endDisapproved(tx: Tx, run: Run, nodeKey: string): Promise<void> {
  await cancelPending(tx, run.ctx, run.instance.id);
  run.instance = { ...run.instance, status: 'disapproved', currentNodeKey: null, returnedFromNodeKey: null };
  await appendLog(tx, run.ctx, run.instance, { event: 'disapprove', nodeKey, actorUserId: null });
  await ADAPTERS[run.instance.businessType].disapproved(tx, run.ctx, run.instance.businessId);
  run.events.push('approval.instance.disapproved');
}

/**
 * 退回发起人（实例“退回”）：驳回，以及会签规则无法达成（暂定，#57）共用。在办任务取消，业务单回到可修改重提的状态，
 * 重提按本节点的「驳回后提交方式」（DEC-053 / DEC-103）。「不同意」不走这里，见 followExit。
 */
export async function returnInstance(tx: Tx, run: Run, nodeKey: string): Promise<void> {
  await cancelPending(tx, run.ctx, run.instance.id);
  run.instance = { ...run.instance, status: 'returned', currentNodeKey: null, returnedFromNodeKey: nodeKey };
  await ADAPTERS[run.instance.businessType].rejected(tx, run.ctx, run.instance.businessId);
  run.events.push('approval.instance.returned');
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
  await assertActorUsable(tx, ctx);
  const latest = await resumableInstanceOf(tx, ctx.tenantId, request.businessType, request.businessId);
  if (latest?.status === 'running') throw approvalError('CONFLICT', 'APPROVAL_ALREADY_RUNNING', '该申请已在审批中');
  if (latest) return resume(tx, ctx, latest.id);
  const snapshot = await ADAPTERS[request.businessType].snapshot(tx, ctx, request.businessId);
  return launch(tx, ctx, request, snapshot, await matchProcess(tx, ctx, snapshot));
}

async function launch(
  tx: Tx,
  ctx: ApprovalContext,
  request: StartRequest,
  snapshot: BusinessSnapshot,
  matched: Awaited<ReturnType<typeof matchProcess>>,
): Promise<InstanceRow> {
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

/**
 * 按业务指定的流程发起（R3-T07 K-08：IDP 子流程引用审批中心的一条流程）。仍先按审批类型过滤（DEC-017），只在该类型的
 * 已发布流程里取指定的那一条，其发起条件不满足即拒绝，不跨流程兜底（AGENTS §2 第 8 条）；没有重提（业务侧另起实例）。
 */
export async function startSpecified(
  tx: Tx,
  ctx: ApprovalContext,
  request: StartRequest & { readonly processId: string },
): Promise<InstanceRow> {
  await assertActorUsable(tx, ctx);
  const latest = await resumableInstanceOf(tx, ctx.tenantId, request.businessType, request.businessId);
  if (latest) throw approvalError('CONFLICT', 'APPROVAL_ALREADY_RUNNING', '该申请已在审批中');
  const snapshot = await ADAPTERS[request.businessType].snapshot(tx, ctx, request.businessId);
  const matched = await matchProcess(tx, ctx, snapshot, request.processId);
  return launch(tx, ctx, request, snapshot, matched);
}

async function matchProcess(tx: Tx, ctx: ApprovalContext, snapshot: BusinessSnapshot, processId?: string) {
  const type = snapshot.approvalType;
  const published = await candidates(tx, ctx.tenantId, {
    objectCode: APPROVAL_TYPES[type].objectCode,
    approvalType: type,
    scope: 'published',
  });
  const list = processId === undefined ? published : published.filter((item) => item.processId === processId);
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  if (type.startsWith('contract_')) {
    for (const candidate of list) {
      const [unsupported] = conditionViolations(candidate.version.conditions, APPROVAL_TYPES[type].conditionFields);
      if (unsupported) throw approvalError('CONFLICT', 'APPROVAL_CONDITION_UNSUPPORTED', unsupported);
    }
  }
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
