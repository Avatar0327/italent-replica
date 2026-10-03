/** 审批动作的判定规则（纯函数）：详情公布的动作与命令执行共用同一套计算，避免“公布了却执行不了”（X-15 / X-16）。 */
import { urgeAllowed, type ApprovalNode } from '@italent/domain';
import type { VersionView } from './definitions.js';
import type { InstanceRow, TaskRow } from './store.js';

/** 系统自动处理的任务（自动同意 / 自动跳过 / 自审跳过），不算人工处理。 */
const AUTO_ORIGINS = new Set(['same_skip', 'history_skip', 'self_skip']);
const untouchedStatus = (task: TaskRow) =>
  task.status === 'pending' ||
  task.status === 'queued' ||
  (AUTO_ORIGINS.has(task.origin) && task.status !== 'rejected');

/**
 * DEC-097 审批人撤回：本人在开启撤回的节点上已同意，且其后还没有任何人工处理（只有待办或自动跳过）时可撤回。
 * TODO(需取证 #37)：原站审批人撤回的时限与效果未取证；首版以“其后尚无人工处理”为界。
 */
export function retrievableTask(
  instance: InstanceRow,
  version: VersionView,
  tasks: readonly TaskRow[],
  userId: string,
): TaskRow | null {
  if (instance.status !== 'running') return null;
  const mine = tasks
    .filter(
      (task) =>
        task.assigneeUserId === userId &&
        task.status === 'approved' &&
        task.round === instance.round &&
        !AUTO_ORIGINS.has(task.origin),
    )
    .at(-1);
  if (!mine || !nodeOf(version, mine.nodeKey)?.actions.retrieve) return null;
  const later = tasks.filter((task) => task.seq > mine.seq);
  return later.length > 0 && later.every(untouchedStatus) ? mine : null;
}

export function nodeOf(version: VersionView, key: string | null): ApprovalNode | undefined {
  return version.nodes.find((node) => node.key === key);
}

/** X-15：当前节点是否允许催办（节点开启 / 关闭覆盖流程设置，继承时取流程设置）。 */
export function urgeOpen(instance: InstanceRow, version: VersionView): boolean {
  const node = nodeOf(version, instance.currentNodeKey);
  return instance.status === 'running' && node !== undefined && urgeAllowed(version.urgeEnabled, node);
}

const ADD_SIGN_ORIGINS = new Set(['add_sign_before', 'add_sign_after']);
/** 改派类来源：任务换了人，但仍属于原来那条加签链。 */
const REASSIGN_ORIGINS = new Set(['transfer', 'admin_transfer', 'admin_intervene', 'blind_review', 'handover']);

/**
 * 加签人的任务被转交 / 改派 / 盲审转异常管理员后，接手人仍在原来那条加签链上。
 */
export interface AddSignLink {
  readonly origin: 'add_sign_before' | 'add_sign_after';
  /** 发起加签的原审批人任务。 */
  readonly signerTaskId: string;
}

/** 任务所在的加签链；不是加签人的任务返回 null。 */
export function addSignLink(tasks: readonly TaskRow[], task: TaskRow): AddSignLink | null {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  let current: TaskRow | undefined = task;
  for (let depth = 0; current && depth <= tasks.length; depth++) {
    if (ADD_SIGN_ORIGINS.has(current.origin) && current.parentTaskId) {
      return { origin: current.origin as AddSignLink['origin'], signerTaskId: current.parentTaskId };
    }
    if (!REASSIGN_ORIGINS.has(current.origin) || !current.parentTaskId) return null;
    current = byId.get(current.parentTaskId);
  }
  return null;
}
