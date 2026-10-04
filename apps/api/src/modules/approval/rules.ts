/** 审批动作的判定规则（纯函数）：详情公布的动作与命令执行共用同一套计算，避免“公布了却执行不了”（X-15 / X-16）。 */
import { isCountersign, urgeAllowed, type ApprovalNode } from '@italent/domain';
import type { VersionView } from './definitions.js';
import { OPEN_STATUSES, type InstanceRow, type TaskRow } from './store.js';

/** 系统自动处理的任务（自动同意 / 自动跳过 / 自审跳过），不算人工处理。 */
const AUTO_ORIGINS = new Set(['same_skip', 'history_skip', 'self_skip']);
const untouchedStatus = (task: TaskRow) =>
  task.status === 'pending' ||
  task.status === 'queued' ||
  (AUTO_ORIGINS.has(task.origin) && task.status !== 'rejected');

/**
 * DEC-097 审批人撤回：本人在开启撤回的节点上已同意，且其后还没有任何人工处理（只有待办或自动跳过）时可撤回。
 * F4：加签链上的同意（加签人本人的同意，或发起了加签的原审批人的同意，含并加签）不能撤回——撤回会取消其后的待办，
 * 首版无法保留并恢复尚未完成的加签义务，因此拒绝这种组合。会签节点见 countersignRetrievable（F-003）。
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
  const node = mine && nodeOf(version, mine.nodeKey);
  if (!mine || !node?.actions.retrieve) return null;
  if (addSignLink(tasks, mine) || startedAddSign(tasks, mine)) return null;
  if (isCountersign(node)) return countersignRetrievable(instance, tasks, mine) ? mine : null;
  const later = tasks.filter((task) => task.seq > mine.seq);
  return later.length > 0 && later.every(untouchedStatus) ? mine : null;
}

/**
 * F-003 会签节点的审批人撤回：同一节点的其他人与本人的同意互不依赖，所以只看本次激活之外的任务。
 * 节点尚未流转（仍有在办任务）时只撤回本人的同意；已沿「同意」流转时，其后还没有人工处理才能撤回（之后恢复本节点
 * 因流转而结束的任务）。同一个同意只能撤回一次；被跳转或驳回中断的激活不能撤回。
 */
function countersignRetrievable(instance: InstanceRow, tasks: readonly TaskRow[], mine: TaskRow): boolean {
  if (tasks.some((task) => task.parentTaskId === mine.id && task.origin === 'retrieve')) return false;
  const activation = tasks.filter((task) => task.activationId === mine.activationId);
  if (activation.some((task) => OPEN_STATUSES.has(task.status))) return instance.currentNodeKey === mine.nodeKey;
  if (activation.some((task) => task.status === 'cancelled')) return false;
  const later = tasks.filter((task) => task.seq > mine.seq && task.activationId !== mine.activationId);
  return later.length > 0 && later.every(untouchedStatus);
}

/**
 * F-003：会签节点同一激活中仍在办的审批人。转交、并加签、管理员转交 / 改派不能再派给他们——会签一人一票；系统接管
 * （异常管理员交接、停用接管）不受此限，保证不停顿。
 */
export function openAssigneesOf(tasks: readonly TaskRow[], task: TaskRow): Set<string> {
  return new Set(
    tasks
      .filter((candidate) => candidate.activationId === task.activationId && OPEN_STATUSES.has(candidate.status))
      .flatMap((candidate) => (candidate.assigneeUserId ? [candidate.assigneeUserId] : [])),
  );
}

export function nodeOf(version: VersionView, key: string | null): ApprovalNode | undefined {
  return version.nodes.find((node) => node.key === key);
}

/** X-15：当前节点是否允许催办（节点开启 / 关闭覆盖流程设置，继承时取流程设置）。 */
export function urgeOpen(instance: InstanceRow, version: VersionView): boolean {
  const node = nodeOf(version, instance.currentNodeKey);
  return instance.status === 'running' && node !== undefined && urgeAllowed(version.urgeEnabled, node);
}

const ADD_SIGN_ORIGINS = new Set(['add_sign_before', 'add_sign_after', 'add_sign_parallel']);
/**
 * 改派类来源：任务换了人，但仍属于原来那条加签链。exception_admin 带上级任务时是排队加签人已不可审批、
 * 转异常管理员接替（F8）；路由产生的异常管理员任务没有上级任务，不会被当成加签链。countersign_reopen 是会签节点
 * 撤回后恢复的原任务（F-003），仍是原来的身份。
 */
const REASSIGN_ORIGINS = new Set([
  'transfer',
  'admin_transfer',
  'admin_intervene',
  'blind_review',
  'handover',
  'exception_admin',
  'countersign_reopen',
]);

/**
 * 加签人的任务被转交 / 改派 / 盲审转异常管理员后，接手人仍在原来那条加签链上。
 */
export interface AddSignLink {
  readonly origin: 'add_sign_before' | 'add_sign_after' | 'add_sign_parallel';
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

/** 该任务的审批人发起过加签（其下挂着加签任务）。 */
function startedAddSign(tasks: readonly TaskRow[], task: TaskRow): boolean {
  return tasks.some((candidate) => candidate.parentTaskId === task.id && ADD_SIGN_ORIGINS.has(candidate.origin));
}

/**
 * F5：加签人不能再加签。嵌套加签需要保存完整的加签层级与返回点，首版不支持，在入口明确拒绝，
 * 避免返回后丢失外层链、留下无人可办的排队任务。
 */
export function addSignAllowed(tasks: readonly TaskRow[], task: TaskRow): boolean {
  return addSignLink(tasks, task) === null;
}

/** DEC-092：本人发起或本人为异动对象的申请，管理员不能转交或干预（详情展示与执行共用）。 */
export function isOwnRequest(
  instance: Pick<InstanceRow, 'initiatorUserId'>,
  subjectUserId: string | null,
  userId: string,
) {
  return userId === instance.initiatorUserId || userId === subjectUserId;
}
