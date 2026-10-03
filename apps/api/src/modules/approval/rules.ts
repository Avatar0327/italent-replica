/** 审批动作的判定规则（纯函数）：详情公布的动作与命令执行共用同一套计算，避免“公布了却执行不了”（X-15 / X-16）。 */
import { urgeAllowed, type ApprovalNode } from '@italent/domain';
import type { VersionView } from './definitions.js';
import type { InstanceRow, TaskRow } from './store.js';

const AUTO_ORIGINS = new Set(['same_skip', 'history_skip', 'self_skip']);

/**
 * DEC-097 审批人撤回：本人在开启撤回的节点上已同意，且其后还没有任何人工处理（只有待办或自动跳过）时可撤回。
 * TODO(需取证 Q-M0-48)：原站审批人撤回的时限与效果未取证；首版以“其后尚无人工处理”为界。
 */
export function retrievableTask(
  instance: InstanceRow,
  version: VersionView,
  tasks: readonly TaskRow[],
  userId: string,
): TaskRow | null {
  if (instance.status !== 'running') return null;
  const mine = tasks
    .filter((task) => task.assigneeUserId === userId && task.status === 'approved' && task.round === instance.round)
    .at(-1);
  if (!mine || !nodeOf(version, mine.nodeKey)?.actions.retrieve) return null;
  const later = tasks.filter((task) => task.seq > mine.seq);
  const untouched = later.every(
    (task) => task.status === 'pending' || (task.status === 'skipped' && AUTO_ORIGINS.has(task.origin)),
  );
  return later.length > 0 && untouched ? mine : null;
}

export function nodeOf(version: VersionView, key: string | null): ApprovalNode | undefined {
  return version.nodes.find((node) => node.key === key);
}

/** X-15：当前节点是否允许催办（节点开启 / 关闭覆盖流程设置，继承时取流程设置）。 */
export function urgeOpen(instance: InstanceRow, version: VersionView): boolean {
  const node = nodeOf(version, instance.currentNodeKey);
  return instance.status === 'running' && node !== undefined && urgeAllowed(version.urgeEnabled, node);
}
