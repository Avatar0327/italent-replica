/**
 * 电子签署任务的事件与状态迁移（F-481 设计 §5.1、§6.3）：纯函数，无 IO。
 * 模拟确认与将来真实对接共用同一组事件；唯一改状态的服务函数 applySignEvent 先问这里“允许吗、结果是什么”。
 */

export type SignNode = 'employee' | 'enterprise';
export type SignStatus = 'signing' | 'completed' | 'revoked' | 'expired' | 'failed';
export type SignRevokeCause = 'manual' | 'business_deleted';

export type SignEvent =
  | { type: 'node_signed'; node: SignNode; actorUserId: string | null; at: Date }
  | { type: 'revoked'; cause: SignRevokeCause; actorUserId: string | null; at: Date }
  | { type: 'expired'; at: Date }
  /** 本单不产生，留给真实对接（设计 §5.1）。 */
  | { type: 'provider_failed'; reason: string; at: Date };

/** 迁移判断所需的任务字段（不含展示信息）。 */
export interface SignTaskState {
  readonly status: SignStatus;
  readonly currentNode: SignNode | null;
}

export const TERMINAL_STATUSES: readonly SignStatus[] = ['completed', 'revoked', 'expired', 'failed'];

export function isTerminal(status: SignStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 任何事件作用于终态任务都拒绝（终态吸收，设计 §5.1 / §6.3）；ESIGN_TASK_CLOSED → 409。 */
export type SignTransitionRejection = 'ESIGN_TASK_CLOSED' | 'ESIGN_NODE_MISMATCH';

export type SignTransition =
  { ok: true; status: SignStatus; currentNode: SignNode | null } | { ok: false; reason: SignTransitionRejection };

/** 状态迁移表（设计 §6.3）：给定当前任务与事件，算出下一状态；非法迁移返回拒绝原因，不抛错。 */
export function nextSignState(task: SignTaskState, event: SignEvent): SignTransition {
  if (isTerminal(task.status) || task.currentNode === null) return { ok: false, reason: 'ESIGN_TASK_CLOSED' };
  switch (event.type) {
    case 'node_signed':
      // 只能签当前节点；员工节点之后是企业节点，企业节点签完即 completed。
      if (event.node !== task.currentNode) return { ok: false, reason: 'ESIGN_NODE_MISMATCH' };
      return event.node === 'employee'
        ? { ok: true, status: 'signing', currentNode: 'enterprise' }
        : { ok: true, status: 'completed', currentNode: null };
    case 'revoked':
      return { ok: true, status: 'revoked', currentNode: null };
    case 'expired':
      return { ok: true, status: 'expired', currentNode: null };
    case 'provider_failed':
      return { ok: true, status: 'failed', currentNode: null };
  }
}
