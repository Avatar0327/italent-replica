/**
 * F-478 节点出口的后继分支（docs/08_设计/F-478_审批条件分支与预置流程_设计.md §2～§3）：出口注册表、分支校验与后继解析。
 * 纯函数、无 IO。没有 routes 的节点保持线性语义：同意 → 下一个节点（末位即结束），不同意 → 结束（EXIT_TARGETS）。
 */
import { conditionViolations, evaluateCondition, type ConditionContext } from './conditions.js';
import {
  isCountersign,
  nodeExits,
  type ApprovalNode,
  type BusinessExit,
  type ConditionField,
  type ProcessCondition,
} from './types.js';

/** 分支去向“结束流程”（数据库里 target_node_key 为空）。节点 key 全为小写，不会与它冲突。 */
export const ROUTE_END = 'END';
/** 单个出口最多的分支数（含 Else）。 */
export const MAX_ROUTE_BRANCHES = 10;
/** 分支条件项上限，对应 item_no 的数据库范围。 */
export const MAX_ROUTE_CONDITION_ITEMS = 20;
/** 条件分支优先级的可存储上限：库里是 smallint，越界写库会变成 500，所以在域内就按 invalid_condition 拒绝。 */
export const MAX_ROUTE_PRIORITY = 32767;

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
export const BUSINESS_EXIT_CODES: readonly BusinessExit[] = ['approve_no_rehire', 'approve_rehire'];

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
  /** 守卫读取的事实字段（条件字段路径）；仿真数据缺少其中任一个时不猜出口，路径推演停在本节点（设计 §3.4）。 */
  readonly requires: readonly string[];
  readonly members: readonly ExitGroupMember[];
}

/** 退休「是否同时返聘」事实：条件字段 business.reEmployed，取值 'true' / 'false'（适配器快照给出，设计 §3.3 / §6.1）。 */
export const RE_EMPLOYED_FACT = 'business.reEmployed';

/**
 * 业务出口组登记表。退休审批的 HRBP 节点（预置 hr_interview，S1 契约的 nodeKeys）有「不返聘 / 同时返聘」一对同意族出口，
 * 由 reEmployed 决定哪一个成立；其余审批类型与节点一律被 `business_exit_type` 拒绝。
 */
export const EXIT_GROUPS: readonly ExitGroup[] = [
  {
    code: 'rehire_choice',
    approvalType: 'retirement',
    nodeKeys: ['hr_interview'],
    requires: [RE_EMPLOYED_FACT],
    members: [
      { exit: 'approve_no_rehire', family: 'approve', guard: (facts) => facts[RE_EMPLOYED_FACT] === 'false' },
      { exit: 'approve_rehire', family: 'approve', guard: (facts) => facts[RE_EMPLOYED_FACT] === 'true' },
    ],
  },
];

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
    const priority = branch.priority ?? 0;
    const prioritized = Number.isSafeInteger(priority) && priority >= 1 && priority <= MAX_ROUTE_PRIORITY;
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

export interface PathStep {
  readonly nodeKey: string;
  /** 本节点选的出口；节点没有可自动选的出口时为 null。 */
  readonly exit: string | null;
  readonly branchNo: number | null;
  /** 分支条件所需字段在数据里缺失：不猜路径，推演停在本节点（设计 §3.4）。 */
  readonly undetermined?: true;
}

export interface PathWalk {
  readonly steps: readonly PathStep[];
  /** end：走到结束；undetermined：缺字段停住；stuck：本节点没有可自动选的出口（如只配了不同意）。 */
  readonly end: 'end' | 'undetermined' | 'stuck';
}

/** 节点某出口的分支条件引用了 context 里没有给出的字段（缺失与“给了空值”不同：后者是已知的空）。 */
function missingFields(node: ApprovalNode, exit: string, context: ConditionContext): boolean {
  const branches = node.routes?.find((route) => route.exit === exit)?.branches ?? [];
  return branches.some((branch) =>
    (branch.conditions?.items ?? []).some((item) => !Object.hasOwn(context.values, item.field)),
  );
}

/** 业务出口节点的守卫要读的事实字段在 context 里缺失：无法确定走哪个出口，仿真不猜。 */
function missingGuardFacts(node: ApprovalNode, approvalType: string, context: ConditionContext): boolean {
  if (!nodeExits(node).some(isBusinessExit)) return false;
  const requires = exitGroupOf(approvalType, node.key)?.requires ?? [];
  return requires.some((field) => !Object.hasOwn(context.values, field));
}

/**
 * 从 startKey 起按「默认同意族出口」推演后继，直到结束 / 缺字段 / 无可选出口（设计 §3.4、§4）。
 * 仿真（虚拟数据）与详情 path（当前快照）共用，两边不各自解释路由。
 * stopOnMissing=true（仿真）：条件字段在 context 里缺失就停；false（详情）：快照里缺失按空值求值，与引擎推进一致。
 */
export function walkDefaultPath(
  nodes: readonly ApprovalNode[],
  startKey: string,
  approvalType: string,
  context: ConditionContext,
  stopOnMissing = true,
): PathWalk {
  const steps: PathStep[] = [];
  const seen = new Set<string>();
  let key = startKey;
  while (!seen.has(key)) {
    seen.add(key);
    const node = nodes.find((candidate) => candidate.key === key);
    if (!node) break;
    if (stopOnMissing && missingGuardFacts(node, approvalType, context)) {
      steps.push({ nodeKey: key, exit: null, branchNo: null, undetermined: true });
      return { steps, end: 'undetermined' };
    }
    const exit = autoApproveExit(node, approvalType, context.values);
    if (exit === null) {
      steps.push({ nodeKey: key, exit: null, branchNo: null });
      return { steps, end: 'stuck' };
    }
    if (stopOnMissing && missingFields(node, exit, context)) {
      steps.push({ nodeKey: key, exit, branchNo: null, undetermined: true });
      return { steps, end: 'undetermined' };
    }
    const successor = resolveSuccessor(nodes, key, exit, context);
    steps.push({ nodeKey: key, exit, branchNo: successor.branchNo });
    if (successor.target === ROUTE_END) break;
    key = successor.target;
  }
  return { steps, end: 'end' };
}

/**
 * 业务出口节点上当前可办理的同意族出口：守卫成立的那些（正常恰好一个）。普通节点没有业务出口，返回空。
 * 办理入口（409 校验）、详情披露（exits）与自动处理（autoApproveExit）共用这一处，三处不会各自解释守卫。
 */
export function availableBusinessExits(
  node: ApprovalNode,
  approvalType: string,
  facts: Readonly<Record<string, unknown>>,
): string[] {
  const exits = rawExits(node);
  if (!exits.some(isBusinessExit)) return [];
  const group = exitGroupOf(approvalType, node.key);
  return (group?.members ?? [])
    .filter((member) => member.family === 'approve' && exits.includes(member.exit) && member.guard(facts))
    .map((member) => member.exit);
}

/** 节点是否有业务出口（办理时必须显式选出口）。 */
export const hasBusinessExits = (node: ApprovalNode): boolean => rawExits(node).some(isBusinessExit);

/** 节点能办「同意」：有「同意」出口，或有业务出口（同意族）。办理页公布 approve 动作、编辑并同意据此判定。 */
export const hasApproveExit = (node: ApprovalNode): boolean =>
  rawExits(node).includes('approve') || hasBusinessExits(node);

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
  const passing = availableBusinessExits(node, approvalType, facts);
  return passing.length === 1 ? passing[0]! : null;
}
