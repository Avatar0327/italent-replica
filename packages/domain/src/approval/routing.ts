/**
 * 节点审批人决策（纯函数）：三种内建机制（`14` §2.2）+ 首节点为空报错（DEC-054）+ 自审（DEC-058 / DEC-068）。
 * 顺序：审批人为空 → 自审（优先于相同审批人自动处理，DEC-068）→ 相同 / 历史相同审批人自动处理 → 派任务。
 * 自动处理的结果按节点配置为「同意」或「跳过」（DEC-106）。
 * TODO(需取证 Q-M0-43，#39)：“历史节点”是否跨驳回重提的轮次未取证，首版只认本轮（engine.routingFacts）。
 */
import type { ApprovalNode, AutoResult } from './types.js';

/** 表达式解析出的人员与其绑定的账号（无账号视为审批人为空）。 */
export interface Candidate {
  readonly personId: string | null;
  readonly userId: string | null;
}

export interface RoutingFacts {
  readonly isFirstNode: boolean;
  readonly initiatorUserId: string;
  readonly subjectEmployeeId: string | null;
  readonly subjectUserId: string | null;
  readonly exceptionAdminUserId: string;
  /** 相邻上一节点的比较对象（相同审批人跳过）：DEC-114 取上一节点解析出的候选人（policies.previousNodeComparand）。 */
  readonly previousApproverUserId: string | null;
  /** 本实例本轮、有效历史边界之后已同意过的人（历史相同审批人跳过；干预 / 跳转前的同意不算，F7）。 */
  readonly approvedUserIds: readonly string[];
  /** 本实例已分配过任务的人（DEC-068“已在本单审批链上”）。 */
  readonly chainUserIds: readonly string[];
}

export type AutoOutcome = 'same_skip' | 'history_skip';
export type AssignOrigin = 'resolved' | 'self_skip_manager' | 'exception_admin';

export type NodeDecision =
  | {
      readonly kind: 'assign';
      readonly userId: string;
      readonly origin: AssignOrigin;
      readonly isExceptionAdmin: boolean;
      /** 被自审跳过的原审批人（不计为同意）。 */
      readonly selfSkippedUserId: string | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'auto';
      /** 触发自动处理的机制：与上一节点相同 / 与历史节点相同。 */
      readonly outcome: AutoOutcome;
      /** 自动处理的结果（DEC-106）。 */
      readonly result: AutoResult;
      readonly userId: string | null;
      readonly reason: string;
    }
  | { readonly kind: 'first_node_empty'; readonly reason: string };

export function isSelf(candidate: Candidate, facts: RoutingFacts): boolean {
  return (
    (candidate.userId !== null &&
      (candidate.userId === facts.initiatorUserId || candidate.userId === facts.subjectUserId)) ||
    (candidate.personId !== null && candidate.personId === facts.subjectEmployeeId)
  );
}

function exceptionAdmin(facts: RoutingFacts, reason: string, selfSkippedUserId: string | null): NodeDecision {
  return {
    kind: 'assign',
    userId: facts.exceptionAdminUserId,
    origin: 'exception_admin',
    isExceptionAdmin: true,
    selfSkippedUserId,
    reason,
  };
}

function auto(outcome: AutoOutcome, result: AutoResult, userId: string, why: string): NodeDecision {
  return { kind: 'auto', outcome, result, userId, reason: `${why}，${result === 'skip' ? '自动跳过' : '自动同意'}` };
}

/**
 * @param manager 自审时该审批人任职记录上的直线经理（调用方按需解析）。
 */
export function decideNode(
  node: Pick<
    ApprovalNode,
    'sameAssigneeSkip' | 'historySameAssigneeSkip' | 'sameAssigneeResult' | 'historySameAssigneeResult'
  >,
  candidate: Candidate,
  facts: RoutingFacts,
  manager: Candidate = { personId: null, userId: null },
): NodeDecision {
  if (candidate.userId === null) {
    if (facts.isFirstNode) return { kind: 'first_node_empty', reason: '第一个审批节点没有审批人' };
    return exceptionAdmin(facts, '审批人为空，转异常管理员', null);
  }
  if (isSelf(candidate, facts)) {
    const selfSkipped = candidate.userId;
    const managerInvalid = manager.userId === null || manager.userId === selfSkipped || isSelf(manager, facts);
    if (managerInvalid) return exceptionAdmin(facts, '自审跳过；直线经理为空或仍为本人，转异常管理员', selfSkipped);
    if (facts.chainUserIds.includes(manager.userId!)) {
      return exceptionAdmin(facts, '自审跳过；直线经理已在本单审批链上，转异常管理员', selfSkipped);
    }
    return {
      kind: 'assign',
      userId: manager.userId!,
      origin: 'self_skip_manager',
      isExceptionAdmin: false,
      selfSkippedUserId: selfSkipped,
      reason: '自审跳过（不计为同意），转直线经理',
    };
  }
  if (node.sameAssigneeSkip && candidate.userId === facts.previousApproverUserId) {
    return auto('same_skip', node.sameAssigneeResult, candidate.userId, '与上一节点审批人相同');
  }
  if (node.historySameAssigneeSkip && facts.approvedUserIds.includes(candidate.userId)) {
    return auto('history_skip', node.historySameAssigneeResult, candidate.userId, '历史节点已同意');
  }
  return {
    kind: 'assign',
    userId: candidate.userId,
    origin: 'resolved',
    isExceptionAdmin: false,
    selfSkippedUserId: null,
    reason: '按表达式解析',
  };
}

export type ExceptionAdminChoice =
  | { readonly kind: 'assign'; readonly userId: string; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * DEC-091：异常管理员恰为发起人或异动本人时回避，改派给其直线经理；直线经理为空、仍是本人或已在本单
 * 审批链上时不可用（调用方拒绝提交 / 本次操作并提示调整流程）。
 * @param admin 实际生效的异常管理员（DEC-098：流程上的异常管理员已停用时由租户管理员接管）
 * @param manager 该异常管理员任职记录上的直线经理（仅在需要回避时由调用方解析）
 */
export function avoidSelfExceptionAdmin(
  admin: Candidate,
  facts: Pick<RoutingFacts, 'initiatorUserId' | 'subjectEmployeeId' | 'subjectUserId' | 'chainUserIds'>,
  manager: Candidate = { personId: null, userId: null },
): ExceptionAdminChoice {
  if (admin.userId === null) return { kind: 'unavailable', reason: '流程没有可用的异常管理员' };
  if (!isSelf(admin, facts as RoutingFacts)) return { kind: 'assign', userId: admin.userId, reason: '异常管理员' };
  const invalid = manager.userId === null || manager.userId === admin.userId || isSelf(manager, facts as RoutingFacts);
  if (invalid || facts.chainUserIds.includes(manager.userId!)) {
    return { kind: 'unavailable', reason: '异常管理员是发起人或异动本人，且没有可接替的直线经理，请调整流程' };
  }
  return { kind: 'assign', userId: manager.userId!, reason: '异常管理员是发起人或异动本人，转其直线经理' };
}

export interface SubmitBlocker {
  readonly reason: 'APPROVAL_FIRST_NODE_EMPTY' | 'APPROVAL_EXCEPTION_ADMIN_SELF';
  readonly message: string;
}

/**
 * 提交前预检（运行与仿真共用，F13）：第一个审批节点没有审批人（DEC-054），或异常管理员本人回避后无人接替
 * （DEC-091），都拒绝提交，不等到流程中途卡住。
 * @param firstNode 第一个节点的决策；只核验异常管理员时不传
 */
export function submitBlockers(admin: ExceptionAdminChoice, firstNode?: NodeDecision): SubmitBlocker[] {
  const blockers: SubmitBlocker[] = [];
  if (firstNode?.kind === 'first_node_empty') {
    blockers.push({ reason: 'APPROVAL_FIRST_NODE_EMPTY', message: firstNode.reason });
  }
  if (admin.kind === 'unavailable') blockers.push({ reason: 'APPROVAL_EXCEPTION_ADMIN_SELF', message: admin.reason });
  return blockers;
}
