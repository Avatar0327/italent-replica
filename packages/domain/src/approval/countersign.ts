/**
 * 会签流转规则（DEC-144，`14` §12.1，照搬原站三种）：任一人同意即可（新会签节点默认）、需所有人同意、自定义审批方式。
 * 某个出口动作的点击人数先达到它的规则，节点就沿该动作流转；并加签人计入（手册 129269776）。
 * 本文件只做规则的取值与判定；规则已无法达成之后怎么处理、节点流转后其余待办怎么收回是暂定口径，见 policies.ts。
 */
import {
  EXIT_LABELS,
  EXIT_RULE_KINDS,
  NODE_EXITS,
  nodeExits,
  TRANSITION_RULE_TYPES,
  type CountersignApprovalNode,
  type ExitRule,
  type ExitRules,
  type NodeExit,
  type TransitionRule,
} from './types.js';

const ONE_PERSON: ExitRule = { kind: 'count', value: 1 };
const EVERYONE: ExitRule = { kind: 'percent', value: 100 };
/** 整数条件的上限（DEC-101：输入有界）。 */
export const MAX_EXIT_COUNT = 999;

/**
 * 节点各出口动作的规则（原站保存时生成的 transitionRules）：任一人同意即可 = 每个动作“整数 1”；需所有人同意 =
 * 「同意」百分比 100%、其他动作“整数 1”；自定义审批方式按行取。
 */
export function exitRulesOf(rule: TransitionRule, exits: readonly NodeExit[]): ExitRules {
  if (rule.type === 'custom') return rule.rules ?? {};
  return Object.fromEntries(
    exits.map((exit) => [exit, rule.type === 'all' && exit === 'approve' ? EVERYONE : ONE_PERSON]),
  );
}

/**
 * 达到规则所需的人数：整数按原值；百分比按本节点票数向上取整（“输入 50%，有 5 人审批则至少 3 人”）。百分比最多
 * 两位小数，换成万分比整数计算，避免浮点误差；至少 1 人。
 */
export function exitThreshold(rule: ExitRule, total: number): number {
  if (rule.kind === 'count') return rule.value;
  const basisPoints = Math.round(rule.value * 100);
  return Math.max(1, Math.floor((basisPoints * total + 9999) / 10000));
}

/** 一张票：点了同意 / 不同意，或仍在办。 */
export type CountersignVote = NodeExit | 'open';

export type CountersignOutcome =
  | { readonly kind: 'flow'; readonly exit: NodeExit; readonly count: number; readonly threshold: number }
  | { readonly kind: 'pending' }
  /** 本节点已没有在办票，仍没有动作达到其规则（只会出现在自定义审批方式）。 */
  | { readonly kind: 'stalled' };

/**
 * 按当前的票判定。每次点击后立即判定，一次点击只增加一个动作的计数，所以至多一个动作“先达到”；按出口动作的固定
 * 顺序检查只为结果确定。票数（百分比的分母）= 本节点本次激活中仍有效的任务数，含并加签人。
 */
export function countersignOutcome(rules: ExitRules, votes: readonly CountersignVote[]): CountersignOutcome {
  for (const exit of NODE_EXITS) {
    const rule = rules[exit];
    if (!rule) continue;
    const count = votes.filter((vote) => vote === exit).length;
    const threshold = exitThreshold(rule, votes.length);
    if (count >= threshold) return { kind: 'flow', exit, count, threshold };
  }
  return votes.includes('open') ? { kind: 'pending' } : { kind: 'stalled' };
}

/**
 * 任务状态折算成票。驳回不进流转规则（DEC-144，任一人驳回即整单驳回）；已转交的票随新任务走；被自审跳过的人只是
 * 留痕（票在接替的直线经理）；已取消、已结束的任务不再计票。
 */
const VOTES: Readonly<Record<string, CountersignVote>> = {
  approved: 'approve',
  disagreed: 'disagree',
  pending: 'open',
  queued: 'open',
  add_signed: 'open',
};

export function countersignVote(status: string): CountersignVote | null {
  return Object.hasOwn(VOTES, status) ? VOTES[status]! : null;
}

const hasTwoDecimalsAtMost = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

function exitRuleViolation(key: string, exit: string, rule: ExitRule): string | null {
  const label = `会签节点 ${key} 「${EXIT_LABELS[exit as NodeExit] ?? exit}」的流转条件`;
  if (!EXIT_RULE_KINDS.includes(rule.kind)) return `${label}只能是整数或百分比`;
  if (rule.kind === 'count') {
    const valid = Number.isInteger(rule.value) && rule.value >= 1 && rule.value <= MAX_EXIT_COUNT;
    return valid ? null : `${label}须为 1～${MAX_EXIT_COUNT} 的整数`;
  }
  const valid = rule.value > 0 && rule.value <= 100 && hasTwoDecimalsAtMost(rule.value);
  return valid ? null : `${label}须为大于 0、不超过 100 的百分比，最多两位小数`;
}

const sameRule = (left: ExitRule | undefined, right: ExitRule | undefined) =>
  left?.kind === right?.kind && left?.value === right?.value;

/**
 * 流转规则的结构校验：预设的各动作条件由系统按出口动作生成（读出时一并给出），原样带回可以，改动不行；自定义须为
 * 节点每个出口动作各给一行，且只给出口动作的行。
 */
export function transitionRuleViolations(node: CountersignApprovalNode): string[] {
  const { type, rules } = node.transitionRule;
  if (!TRANSITION_RULE_TYPES.includes(type)) return [`会签节点 ${node.key} 的流转规则不合法`];
  const exits = nodeExits(node);
  if (type !== 'custom') {
    const generated = exitRulesOf(node.transitionRule, exits);
    const same = !rules || NODE_EXITS.every((exit) => sameRule(rules[exit], generated[exit]));
    return same ? [] : [`会签节点 ${node.key} 的预设流转规则由系统按出口动作生成，不能逐个动作修改条件`];
  }
  const violations: string[] = [];
  const given = rules ?? {};
  for (const exit of exits) {
    if (!given[exit]) violations.push(`会签节点 ${node.key} 的自定义审批方式缺少「${EXIT_LABELS[exit]}」的流转条件`);
  }
  for (const [exit, rule] of Object.entries(given)) {
    if (!exits.includes(exit as NodeExit)) {
      const label = EXIT_LABELS[exit as NodeExit] ?? exit;
      violations.push(`会签节点 ${node.key} 没有「${label}」出口动作，不能为它设流转条件`);
      continue;
    }
    const violation = rule ? exitRuleViolation(node.key, exit, rule) : null;
    if (violation) violations.push(violation);
  }
  return violations;
}
