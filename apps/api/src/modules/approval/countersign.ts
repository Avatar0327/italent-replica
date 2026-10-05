/**
 * 会签节点的结算与撤回（F-003，DEC-144，`14` §12）。成员同意 / 不同意后按流转规则判定：某个出口动作的点击人数先达到
 * 它的规则，节点就沿该动作的连线流转（engine.followExit：「同意」进入下一节点，「不同意」连到结束）；其余未处理待办
 * 自动结束（暂定，Q-M0-57）；规则已无法达成时按暂定口径退回（#57）。
 * 一人一票（P2-1）：同一次激活内按有效人员计票，同一人只计一票；前加签人不计入（DEC-152）。系统接管让同一人承接多席
 * 时，多出的那一席记为“由同一人接手、不重复计票”（mergeSeat）。
 * 结算都在实例行锁下进行（openRun 按 F-008 的取锁顺序先锁员工、再锁业务单与实例），过期 revision 与已结束的任务在
 * 入口即被拒（actions.assertOpen），所以同一节点只结算一次、不会重复推进。
 */
import type { Tx } from '@italent/db';
import {
  countersignEndedReason,
  countersignOutcome,
  countersignVote,
  exitRulesOf,
  isCountersign,
  nodeExits,
  STALLED_COUNTERSIGN_HANDLING,
  type CountersignApprovalNode,
  type CountersignVote,
} from '@italent/domain';
import {
  currentRouting,
  exceptionAdminFor,
  followExit,
  logEnded,
  nodeIndex,
  returnInstance,
  type Run,
} from './engine.js';
import { notifyTodo } from './notifications.js';
import { isEligibleApprover } from './resolver.js';
import { votesInTransition } from './rules.js';
import {
  appendLog,
  endOpenTasks,
  insertTask,
  loadTasks,
  OPEN_STATUSES,
  type TaskRow,
  type TaskStatus,
} from './store.js';

/** 节点的同一次激活（F-003）。 */
export function activationOf(tasks: readonly TaskRow[], task: TaskRow): TaskRow[] {
  return tasks.filter((candidate) => candidate.activationId === task.activationId);
}

/**
 * 本次激活中参与计票的任务：前加签链上的任务不计（DEC-152），本人撤回过的同意不再计票、由撤回后的新待办接续
 * （DEC-097）。
 */
function votingTasks(activation: readonly TaskRow[]): TaskRow[] {
  const retrieved = new Set(activation.filter((task) => task.origin === 'retrieve').map((task) => task.parentTaskId));
  return activation.filter((task) => !retrieved.has(task.id) && votesInTransition(activation, task));
}

/**
 * 本次激活中仍有效的票，按人计（一人一票，P2-1）：同一人只计一票，已投的票（同意 / 不同意）优先于仍在办的任务。
 */
export function activationVotes(activation: readonly TaskRow[]): CountersignVote[] {
  const votes = new Map<string, CountersignVote>();
  for (const task of votingTasks(activation)) {
    const vote = countersignVote(task.status);
    if (!vote || task.assigneeUserId === null) continue;
    const held = votes.get(task.assigneeUserId);
    if (held === undefined || held === 'open') votes.set(task.assigneeUserId, vote);
  }
  return [...votes.values()];
}

const HELD: ReadonlySet<TaskStatus> = new Set([...OPEN_STATUSES, 'approved', 'disagreed']);

/** 本次激活中占着一席（在办或已投票）的人。 */
function seatHolders(activation: readonly TaskRow[]): Set<string> {
  return new Set(
    votingTasks(activation)
      .filter((task) => HELD.has(task.status) && task.assigneeUserId !== null)
      .map((task) => task.assigneeUserId!),
  );
}

/** 成员同意 / 不同意之后（或席位合并之后）结算本节点；仍待定时什么都不做。 */
export async function settleCountersign(tx: Tx, run: Run, node: CountersignApprovalNode, acted: TaskRow) {
  // 只结算一次：节点已流转（实例已不在本节点）时不再结算，即使调用方漏了入口校验也不会重复推进。
  if (run.instance.status !== 'running' || run.instance.currentNodeKey !== node.key) return;
  // 旧票不能让改动后的载荷通过（P2-N1）：业务单在审批中被改动时实例已冻结，审批动作一律 APPROVAL_BUSINESS_CHANGED
  // （engine.assertBusinessUnchanged）；系统接管合并席位后的重新结算同样不推进，由发起人撤回后重新提交。
  if (run.snapshot.version !== run.instance.businessVersion) return;
  const activation = activationOf(await loadTasks(tx, run.ctx.tenantId, run.instance.id), acted);
  const rules = exitRulesOf(node.transitionRule, nodeExits(node));
  const outcome = countersignOutcome(rules, activationVotes(activation));
  if (outcome.kind === 'pending') return;
  if (outcome.kind === 'stalled') {
    await appendLog(tx, run.ctx, run.instance, {
      event: 'countersign_stalled',
      nodeKey: node.key,
      actorUserId: null,
      detail: { handling: STALLED_COUNTERSIGN_HANDLING },
    });
    return returnInstance(tx, run, node.key);
  }
  const { exit, count, threshold } = outcome;
  await appendLog(tx, run.ctx, run.instance, {
    event: 'countersign_flow',
    nodeKey: node.key,
    actorUserId: null,
    detail: { exit, count, threshold },
  });
  const reason = countersignEndedReason(exit);
  for (const task of await endOpenTasks(tx, run.ctx, activation)) {
    await logEnded(tx, run, node.key, task.id, task.assigneeUserId, reason);
  }
  await followExit(tx, run, node.key, exit);
}

/** 会签节点上撤回同意时，节点是否已沿出口动作流转（已流转要先取消其后的待办，再恢复本节点结束的任务）。 */
export function countersignFlowed(activation: readonly TaskRow[]): boolean {
  return !activation.some((task) => OPEN_STATUSES.has(task.status));
}

/**
 * 系统接管（异常管理员交接、停用接管、盲审转异常管理员、加签返回或撤回恢复时转异常管理员）要把会签节点的一席交给
 * 已在本节点占着一席的人时，不再给他第二席（一人一票，P2-1）。只看计票的席位，前加签链上的任务不受此限。
 */
export function mergesSeat(run: Run, tasks: readonly TaskRow[], replaced: TaskRow, userId: string): boolean {
  const node = run.version.nodes[nodeIndex(run, replaced.nodeKey)]!;
  if (!isCountersign(node)) return false;
  const activation = activationOf(tasks, replaced);
  return votesInTransition(activation, replaced) && seatHolders(activation).has(userId);
}

/** 多出的那一席记为“由同一人接手、不重复计票”：只留痕、不发待办；调用方随后按一人一票重新结算（resettle）。 */
export async function mergeSeat(
  tx: Tx,
  run: Run,
  replaced: TaskRow,
  userId: string,
  origin: 'handover' | 'blind_review' | 'exception_admin',
): Promise<string> {
  const merged = await insertTask(tx, run.ctx, run.instance.id, {
    round: run.instance.round,
    nodeKey: replaced.nodeKey,
    assigneeUserId: userId,
    origin,
    status: 'merged',
    isExceptionAdmin: true,
    parentTaskId: replaced.id,
    activationId: replaced.activationId,
  });
  await appendLog(tx, run.ctx, run.instance, {
    event: 'countersign_merge',
    nodeKey: replaced.nodeKey,
    taskId: merged,
    actorUserId: null,
    detail: { fromUserId: replaced.assigneeUserId, toUserId: userId, reason: '由同一人接手、不重复计票' },
  });
  return merged;
}

/** 席位合并后人数变了，按一人一票重新结算本节点（例如需所有人同意时，剩下的人都已同意即流转）。 */
export async function resettle(tx: Tx, run: Run, replaced: TaskRow): Promise<void> {
  const node = run.version.nodes[nodeIndex(run, replaced.nodeKey)]!;
  if (isCountersign(node)) await settleCountersign(tx, run, node, replaced);
}

/** 已被恢复过的任务（其下挂着恢复出的任务）不再恢复。 */
const RESTORE_ORIGINS = new Set(['countersign_reopen', 'exception_admin']);

/**
 * 撤回已流转的会签节点（DEC-097）：恢复因节点流转而结束、尚未恢复过的席位，节点回到流转之前的状态；只恢复计票的
 * 席位，每人一席。流转时还有未完成的前加签的，撤回在入口即被拒（rules.countersignRetrievable，P2-N2），不会走到这里。
 * 原审批人已不可审批时转异常管理员（同 F8），异常管理员已占着一席时合并（P2-1）。不留无人可办的任务。
 * @param holders 撤回之后仍占着一席的人（含撤回人）
 * @returns 是否发生了席位合并（调用方据此重新结算）
 */
export async function reopenEnded(
  tx: Tx,
  run: Run,
  activation: readonly TaskRow[],
  tasks: readonly TaskRow[],
  holders: Set<string>,
): Promise<boolean> {
  const restored = new Set(tasks.filter((task) => RESTORE_ORIGINS.has(task.origin)).map((task) => task.parentTaskId));
  let merged = false;
  for (const task of votingTasks(activation).filter((candidate) => candidate.status === 'ended')) {
    if (restored.has(task.id) || task.assigneeUserId === null || holders.has(task.assigneeUserId)) continue;
    const routing = await currentRouting(tx, run, task.nodeKey);
    const usable = await isEligibleApprover(tx, routing.subject, task.assigneeUserId);
    const admin = usable ? null : await exceptionAdminFor(tx, run, routing.subject, routing.facts);
    if (admin && holders.has(admin.userId)) {
      await mergeSeat(tx, run, task, admin.userId, 'exception_admin');
      merged = true;
      continue;
    }
    const assigneeUserId = admin?.userId ?? task.assigneeUserId;
    holders.add(assigneeUserId);
    const next = await insertTask(tx, run.ctx, run.instance.id, {
      round: run.instance.round,
      nodeKey: task.nodeKey,
      assigneeUserId,
      origin: admin ? 'exception_admin' : 'countersign_reopen',
      status: 'pending',
      isExceptionAdmin: admin !== null || task.isExceptionAdmin,
      parentTaskId: task.id,
      activationId: task.activationId,
    });
    const reason = admin ? `原审批人已不可审批；${admin.reason}` : '审批人撤回同意，节点恢复审批';
    await appendLog(tx, run.ctx, run.instance, {
      event: 'countersign_reopen',
      nodeKey: task.nodeKey,
      taskId: next,
      detail: { fromTaskId: task.id, toUserId: assigneeUserId, reason },
    });
    await notifyTodo(tx, run.ctx, run.instance, next, assigneeUserId);
  }
  return merged;
}

/** 撤回之后仍占着一席的人：本次激活中在办或已投票的人（撤回人本人的同意已被撤回、由新待办接续），再加上撤回人。 */
export function holdersAfterRetrieve(activation: readonly TaskRow[], retriever: string): Set<string> {
  const holders = seatHolders(activation);
  holders.add(retriever);
  return holders;
}
