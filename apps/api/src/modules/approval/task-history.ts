import type { TaskRow } from './store.js';

/** DEC-097：撤回保留原同意行，用 retrieve.parentTaskId 使其失效；撤回任务后来转交也不恢复旧同意。 */
export function withoutRetrievedApprovals(tasks: readonly TaskRow[]): TaskRow[] {
  const retrieved = new Set(tasks.filter((task) => task.origin === 'retrieve').map((task) => task.parentTaskId));
  return tasks.filter((task) => !retrieved.has(task.id));
}

const AUTOMATIC = new Set(['same_skip', 'history_skip', 'self_skip', 'subject_skip', 'no_assignee_approve']);

/** DEC-686：人工实际同意与会签计票资格不同，前加签人的真实办理也保留。调用方先裁剪轮次与激活。 */
export function actualApprovals(tasks: readonly TaskRow[]): TaskRow[] {
  return withoutRetrievedApprovals(tasks).filter((task) => task.status === 'approved' && !AUTOMATIC.has(task.origin));
}
