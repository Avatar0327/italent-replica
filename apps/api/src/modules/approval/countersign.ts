/**
 * 会签节点的结算与撤回（F-003，DEC-144，`14` §12）。成员同意 / 不同意后按流转规则判定：某个出口动作的点击人数先达到
 * 它的规则，节点就沿该动作流转——「同意」进入下一节点，「不同意」退回发起人（复刻首版的不同意连线固定退回，
 * engine.returnInstance）；其余未处理待办自动结束（暂定，Q-M0-57）；规则已无法达成时按暂定口径退回（#57）。
 * 结算都在实例行锁下进行（openRun 按 F-008 的取锁顺序先锁员工、再锁业务单与实例），过期 revision 与已结束的任务在
 * 入口即被拒（actions.assertOpen），所以同一节点只结算一次、不会重复推进。
 */
import type { Tx } from '@italent/db';
import {
  countersignEndedReason,
  countersignOutcome,
  countersignVote,
  exitRulesOf,
  nodeExits,
  STALLED_COUNTERSIGN_EXIT,
  type CountersignApprovalNode,
  type CountersignVote,
} from '@italent/domain';
import {
  advanceFrom,
  currentRouting,
  exceptionAdminFor,
  logEnded,
  nodeIndex,
  returnInstance,
  type Run,
} from './engine.js';
import { notifyTodo } from './notifications.js';
import { isEligibleApprover } from './resolver.js';
import { appendLog, endOpenTasks, insertTask, loadTasks, OPEN_STATUSES, type TaskRow } from './store.js';

/** 节点的同一次激活（F-003）。 */
export function activationOf(tasks: readonly TaskRow[], task: TaskRow): TaskRow[] {
  return tasks.filter((candidate) => candidate.activationId === task.activationId);
}

/** 本次激活中仍有效的票：本人撤回过的同意不再计票，由撤回后的新待办接续（DEC-097）。 */
export function activationVotes(activation: readonly TaskRow[]): CountersignVote[] {
  const retrieved = new Set(activation.filter((task) => task.origin === 'retrieve').map((task) => task.parentTaskId));
  return activation.flatMap((task) => {
    const vote = retrieved.has(task.id) ? null : countersignVote(task.status);
    return vote ? [vote] : [];
  });
}

/** 成员同意 / 不同意之后结算本节点；仍待定时什么都不做。 */
export async function settleCountersign(tx: Tx, run: Run, node: CountersignApprovalNode, acted: TaskRow) {
  // 只结算一次：节点已流转（实例已不在本节点）时不再结算，即使调用方漏了入口校验也不会重复推进。
  if (run.instance.status !== 'running' || run.instance.currentNodeKey !== node.key) return;
  const activation = activationOf(await loadTasks(tx, run.ctx.tenantId, run.instance.id), acted);
  const rules = exitRulesOf(node.transitionRule, nodeExits(node));
  const outcome = countersignOutcome(rules, activationVotes(activation));
  if (outcome.kind === 'pending') return;
  const exit = outcome.kind === 'flow' ? outcome.exit : STALLED_COUNTERSIGN_EXIT;
  await appendLog(tx, run.ctx, run.instance, {
    event: outcome.kind === 'flow' ? 'countersign_flow' : 'countersign_stalled',
    nodeKey: node.key,
    actorUserId: null,
    detail: outcome.kind === 'flow' ? { exit, count: outcome.count, threshold: outcome.threshold } : { exit },
  });
  const reason = countersignEndedReason(exit);
  for (const task of await endOpenTasks(tx, run.ctx, activation)) {
    await logEnded(tx, run, node.key, task.id, task.assigneeUserId, reason);
  }
  if (exit === 'approve') return advanceFrom(tx, run, nodeIndex(run, node.key) + 1);
  await returnInstance(tx, run, node.key);
}

/** 会签节点上撤回同意时，节点是否已沿出口动作流转（已流转要先取消其后的待办，再恢复本节点结束的任务）。 */
export function countersignFlowed(activation: readonly TaskRow[]): boolean {
  return !activation.some((task) => OPEN_STATUSES.has(task.status));
}

/**
 * 撤回已流转的会签节点（DEC-097）：恢复因节点流转而结束、尚未恢复过的任务，节点回到流转之前的状态；原审批人已不可
 * 审批时转异常管理员（同 F8），不留无人可办的任务。
 */
export async function reopenEnded(tx: Tx, run: Run, activation: readonly TaskRow[], tasks: readonly TaskRow[]) {
  const reopened = new Set(tasks.map((task) => task.parentTaskId));
  for (const task of activation.filter((candidate) => candidate.status === 'ended' && !reopened.has(candidate.id))) {
    const routing = await currentRouting(tx, run, task.nodeKey);
    const usable = task.assigneeUserId !== null && (await isEligibleApprover(tx, routing.subject, task.assigneeUserId));
    const admin = usable ? null : await exceptionAdminFor(tx, run, routing.subject, routing.facts);
    const assigneeUserId = admin?.userId ?? task.assigneeUserId!;
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
}
