/**
 * F-478 节点出口的后继分支（docs/08_设计/F-478_审批条件分支与预置流程_设计.md §2～§3）：出口注册表、分支校验与后继解析。
 * 纯函数、无 IO。没有 routes 的节点保持线性语义：同意 → 下一个节点（末位即结束），不同意 → 结束（EXIT_TARGETS）。
 */
import { conditionViolations, evaluateCondition, type ConditionContext } from './conditions.js';
import { isCountersign, nodeExits, type ApprovalNode, type ConditionField, type ProcessCondition } from './types.js';

/** 分支去向“结束流程”（数据库里 target_node_key 为空）。节点 key 全为小写，不会与它冲突。 */
export const ROUTE_END = 'END';
/** 单个出口最多的分支数（含 Else）。 */
export const MAX_ROUTE_BRANCHES = 10;
/** 分支条件项上限，对应 item_no 的数据库范围。 */
export const MAX_ROUTE_CONDITION_ITEMS = 20;

export type RouteBranchKind = 'condition' | 'else' | 'direct';

export interface RouteBranch {
  readonly kind: RouteBranchKind;
  /** 仅条件分支：数值越小越先判；同出口内唯一。 */
  readonly priority?: number;
  /** 仅条件分支；Else / direct 不带条件。 */
  readonly conditions?: ProcessCondition;
  /** 节点 key 或 ROUTE_END。 */
  readonly target: string;
}

export interface ExitRoute {
  readonly exit: string;
  /** 数组位置即分支序号（branchNo = 位置 + 1），落库后按序读回。 */
  readonly branches: readonly RouteBranch[];
}

export type ExitFamily = 'approve' | 'disagree';

/** 业务出口组的出口编码（数据库 CHECK 的白名单，成对出现）；能否用于某个审批类型由登记表决定。 */
export const BUSINESS_EXIT_CODES = ['approve_no_rehire', 'approve_rehire'] as const;

/** 出口守卫：按本次申请的事实字段判定该业务出口是否成立（自动处理时需恰好一个成立）。 */
export type ExitGuard = (facts: Readonly<Record<string, unknown>>) => boolean;

export interface ExitGroupMember {
  readonly exit: string;
  readonly family: ExitFamily;
  readonly guard: ExitGuard;
}

export interface ExitGroup {
  readonly code: string;
  readonly approvalType: string;
  /** 允许使用该出口组的节点 key。 */
  readonly nodeKeys: readonly string[];
  readonly members: readonly ExitGroupMember[];
}

/** 业务出口组登记表。本片不登记任何业务出口（S3 随审批类型登记），所以业务出口一律被 `business_exit_type` 拒绝。 */
export const EXIT_GROUPS: readonly ExitGroup[] = [];

export function isBusinessExit(exit: string): boolean {
  return (BUSINESS_EXIT_CODES as readonly string[]).includes(exit);
}

export function exitGroupOf(approvalType: string, nodeKey: string): ExitGroup | undefined {
  return EXIT_GROUPS.find((group) => group.approvalType === approvalType && group.nodeKeys.includes(nodeKey));
}

/** 出口归属的族：除「不同意」外都属于同意族（后继为结束时，同意族走“已通过”，不同意族走“未通过”）。 */
export function exitFamily(exit: string): ExitFamily {
  const member = EXIT_GROUPS.flatMap((group) => group.members).find((entry) => entry.exit === exit);
  return member?.family ?? (exit === 'disagree' ? 'disagree' : 'approve');
}

export type RouteReason =
  | 'backward_target'
  | 'self_target'
  | 'duplicate_priority'
  | 'missing_else'
  | 'else_with_condition'
  | 'direct_mixed'
  | 'unreachable_node'
  | 'unknown_field'
  | 'invalid_condition'
  | 'unknown_target'
  | 'exit_not_on_node'
  | 'business_exit_type'
  | 'incomplete_exit_group'
  | 'countersign_business_exit'
  | 'too_many_branches';

export interface RouteViolation {
  readonly reason: RouteReason;
  readonly nodeKey: string;
  readonly exit?: string;
  readonly branchNo?: number;
}

const rawExits = (node: ApprovalNode): readonly string[] => nodeExits(node);

function exitGroupViolations(node: ApprovalNode, approvalType: string | undefined): RouteViolation[] {
  const business = rawExits(node).filter(isBusinessExit);
  if (!business.length) return [];
  const at = { nodeKey: node.key };
  if (isCountersign(node)) return [{ reason: 'countersign_business_exit', ...at }];
  if (business.length !== BUSINESS_EXIT_CODES.length) return [{ reason: 'incomplete_exit_group', ...at }];
  const group = approvalType === undefined ? undefined : exitGroupOf(approvalType, node.key);
  const registered = group?.members.every((member) => business.includes(member.exit));
  return registered ? [] : [{ reason: 'business_exit_type', ...at }];
}

function conditionReason(condition: ProcessCondition, fields: readonly ConditionField[]): RouteReason | null {
  const known = new Set(fields.map((field) => field.path));
  if (condition.items.some((item) => !known.has(item.field))) return 'unknown_field';
  const oversized = condition.items.length > MAX_ROUTE_CONDITION_ITEMS;
  const badNo = condition.items.some((item) => item.no > MAX_ROUTE_CONDITION_ITEMS);
  return oversized || badNo || conditionViolations(condition, fields).length ? 'invalid_condition' : null;
}

function branchViolation(
  branch: RouteBranch,
  node: ApprovalNode,
  index: number,
  keys: readonly string[],
  fields: readonly ConditionField[],
): RouteReason | null {
  if (branch.kind === 'condition') {
    const conditions = branch.conditions;
    const prioritized = Number.isSafeInteger(branch.priority) && (branch.priority ?? 0) >= 1;
    if (!conditions || !conditions.items.length || !prioritized) return 'invalid_condition';
    const reason = conditionReason(conditions, fields);
    if (reason) return reason;
  } else if (branch.conditions?.items.length) {
    return branch.kind === 'else' ? 'else_with_condition' : 'invalid_condition';
  }
  if (branch.target === ROUTE_END) return null;
  const target = keys.indexOf(branch.target);
  if (branch.target === node.key) return 'self_target';
  if (target < 0) return 'unknown_target';
  return target < index ? 'backward_target' : null;
}

function exitShapeViolations(route: ExitRoute, node: ApprovalNode): RouteViolation[] {
  const at = { nodeKey: node.key, exit: route.exit };
  const found: RouteViolation[] = [];
  if (route.branches.length > MAX_ROUTE_BRANCHES) found.push({ reason: 'too_many_branches', ...at });
  const conditional = route.branches.filter((branch) => branch.kind === 'condition');
  const single = route.branches.filter((branch) => branch.kind !== 'condition');
  const priorities = conditional.map((branch) => branch.priority);
  if (new Set(priorities).size !== priorities.length) found.push({ reason: 'duplicate_priority', ...at });
  if (route.branches.some((branch) => branch.kind === 'direct') && route.branches.length > 1) {
    found.push({ reason: 'direct_mixed', ...at });
  } else if (single.length > 1) found.push({ reason: 'direct_mixed', ...at });
  if (conditional.length && !route.branches.some((branch) => branch.kind === 'else')) {
    found.push({ reason: 'missing_else', ...at });
  }
  return found;
}

function routeViolations(
  node: ApprovalNode,
  index: number,
  keys: readonly string[],
  fields: readonly ConditionField[],
): RouteViolation[] {
  const found: RouteViolation[] = [];
  for (const route of node.routes ?? []) {
    if (!route.branches.length) continue;
    const at = { nodeKey: node.key, exit: route.exit };
    if (!rawExits(node).includes(route.exit)) {
      found.push({ reason: 'exit_not_on_node', ...at });
      continue;
    }
    found.push(...exitShapeViolations(route, node));
    route.branches.forEach((branch, position) => {
      const reason = branchViolation(branch, node, index, keys, fields);
      if (reason) found.push({ reason, ...at, branchNo: position + 1 });
    });
  }
  return found;
}

/** 节点各出口的可能去向（含默认去向），供可达性检查。 */
function possibleTargets(nodes: readonly ApprovalNode[], index: number): string[] {
  const node = nodes[index]!;
  const targets: string[] = [];
  for (const exit of rawExits(node)) {
    const branches = node.routes?.find((route) => route.exit === exit)?.branches ?? [];
    if (branches.length) targets.push(...branches.map((branch) => branch.target));
    else if (exitFamily(exit) === 'approve') targets.push(nodes[index + 1]?.key ?? ROUTE_END);
  }
  return targets;
}

function unreachableViolations(nodes: readonly ApprovalNode[]): RouteViolation[] {
  const reachable = new Set<string>(nodes.length ? [nodes[0]!.key] : []);
  nodes.forEach((node, index) => {
    if (reachable.has(node.key)) possibleTargets(nodes, index).forEach((target) => reachable.add(target));
  });
  return nodes
    .filter((node) => !reachable.has(node.key))
    .map((node) => ({ reason: 'unreachable_node', nodeKey: node.key }));
}

/**
 * 保存与发布时的分支校验（设计 §2.4）：目标只能指向更靠后的节点或结束、条件分支必须有 Else、优先级唯一、
 * 非首节点必须可达；出口集合须在节点内，业务出口须成对且已登记，会签节点不得使用。
 */
export function validateRoutes(
  nodes: readonly ApprovalNode[],
  fields: readonly ConditionField[],
  approvalType?: string,
): RouteViolation[] {
  const keys = nodes.map((node) => node.key);
  const found = nodes.flatMap((node, index) => [
    ...exitGroupViolations(node, approvalType),
    ...routeViolations(node, index, keys, fields),
  ]);
  return [...found, ...(nodes.some((node) => node.routes?.length) ? unreachableViolations(nodes) : [])];
}

export interface Successor {
  /** 节点 key 或 ROUTE_END。 */
  readonly target: string;
  /** 命中的分支序号（1 起）；走默认去向时为空。 */
  readonly branchNo: number | null;
}

/** 已发布版本里找不到可用分支（既无命中条件也无 Else）——校验应已拒绝，出现即数据被改动，不放行。 */
export class RouteResolutionError extends Error {
  constructor(
    readonly nodeKey: string,
    readonly exit: string,
  ) {
    super(`节点 ${nodeKey} 的出口 ${exit} 没有可用的后继分支`);
  }
}

/** 解析节点某出口的后继：按优先级数值从小到大取第一条命中的条件分支，都不命中走 Else；direct 直接取其目标。 */
export function resolveSuccessor(
  nodes: readonly ApprovalNode[],
  nodeKey: string,
  exit: string,
  context: ConditionContext,
): Successor {
  const index = nodes.findIndex((node) => node.key === nodeKey);
  const branches = nodes[index]?.routes?.find((route) => route.exit === exit)?.branches ?? [];
  if (!branches.length) {
    const next = exitFamily(exit) === 'approve' ? (nodes[index + 1]?.key ?? ROUTE_END) : ROUTE_END;
    return { target: next, branchNo: null };
  }
  const numbered = branches.map((branch, position) => ({ branch, branchNo: position + 1 }));
  const ordered = numbered
    .filter((entry) => entry.branch.kind === 'condition')
    .sort((a, b) => (a.branch.priority ?? 0) - (b.branch.priority ?? 0));
  const hit = ordered.find((entry) => evaluateCondition(entry.branch.conditions!, context).result);
  const fallback = numbered.find((entry) => entry.branch.kind !== 'condition');
  const chosen = hit ?? fallback;
  if (!chosen) throw new RouteResolutionError(nodeKey, exit);
  return { target: chosen.branch.target, branchNo: chosen.branchNo };
}

/**
 * 自动处理（相同审批人、历史相同、主体回避、无审批人同意）的出口：普通节点取「同意」；业务出口节点取守卫恰好成立的
 * 那一个同意族出口。不唯一（0 个或多个）返回 null，交给人工办理。
 */
export function autoApproveExit(
  node: ApprovalNode,
  approvalType: string,
  facts: Readonly<Record<string, unknown>>,
): string | null {
  const exits = rawExits(node);
  if (!exits.some(isBusinessExit)) return exits.includes('approve') ? 'approve' : null;
  const group = exitGroupOf(approvalType, node.key);
  const passing = (group?.members ?? []).filter(
    (member) => member.family === 'approve' && exits.includes(member.exit) && member.guard(facts),
  );
  return passing.length === 1 ? passing[0]!.exit : null;
}
