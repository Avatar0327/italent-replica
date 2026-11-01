import type { TaskRow } from './store.js';

/**
 * 撤回造成的失效（DEC-097、F-379、F-392），是“任务还能否作为历史依据”在撤回路径上的唯一判定：
 * - retrieved：被撤回的同意（retrieve.parentTaskId）；撤回任务后来转交也不恢复它。
 * - downstream：撤回让流程回到被撤回同意所在的节点，它之后、撤回之前在其他激活产生的下游任务（含历史相同 / 相同审批人
 *   等自动同意）随回退一并失效。同一激活内的任务（会签其他席位）与本人同意互不依赖，保持有效。
 * 只做判定：任务、日志与时间线全部保留。其余回退路径不经这里——驳回 / 撤回申请后重提开新一轮，驳回到上一步、跳转、
 * 管理员干预重置有效历史起点（policies.effectiveHistory）。
 * 被撤回的同意不在列表里时（已被有效历史起点裁掉），起点之后、撤回之前其他激活的任务都在撤回点之后。
 */
function invalidatedByRetrieve(tasks: readonly TaskRow[]): { retrieved: Set<string>; downstream: Set<string> } {
  const seqOf = new Map(tasks.map((task) => [task.id, task.seq]));
  const retrieved = new Set<string>();
  const downstream = new Set<string>();
  for (const retrieve of tasks.filter((task) => task.origin === 'retrieve' && task.parentTaskId !== null)) {
    retrieved.add(retrieve.parentTaskId!);
    const from = seqOf.get(retrieve.parentTaskId!) ?? -Infinity;
    for (const task of tasks) {
      const between = task.seq > from && task.seq < retrieve.seq;
      if (between && task.activationId !== retrieve.activationId) downstream.add(task.id);
    }
  }
  return { retrieved, downstream };
}

/** 去掉被撤回的同意及撤回点之后的下游任务（历史同意、会签计票、人工同意共用）。 */
export function withoutRetrieved(tasks: readonly TaskRow[]): TaskRow[] {
  const { retrieved, downstream } = invalidatedByRetrieve(tasks);
  return tasks.filter((task) => !retrieved.has(task.id) && !downstream.has(task.id));
}

/**
 * 只去掉撤回点之后的下游任务：“与上一节点相同”比较的是节点解析出的候选人（DEC-114），被撤回的同意所在节点的候选人
 * 不因撤回改变，保留；回退前的旧下游激活不再代表上一节点。
 */
export function withoutRewoundDownstream(tasks: readonly TaskRow[]): TaskRow[] {
  const { downstream } = invalidatedByRetrieve(tasks);
  return tasks.filter((task) => !downstream.has(task.id));
}

const AUTOMATIC = new Set(['same_skip', 'history_skip', 'self_skip', 'subject_skip', 'no_assignee_approve']);

/** DEC-686：人工实际同意与会签计票资格不同，前加签人的真实办理也保留。调用方先裁剪轮次与激活。 */
export function actualApprovals(tasks: readonly TaskRow[]): TaskRow[] {
  return withoutRetrieved(tasks).filter((task) => task.status === 'approved' && !AUTOMATIC.has(task.origin));
}
