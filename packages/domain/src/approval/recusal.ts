/**
 * 审批回避判定（F-048，docs/08_设计/F-048_审批多主体回避_设计.md §2、§4.1）：纯函数，只和实例冻结的事实比较。
 * - 节点级：avoidSelf（发起人 ∪ 单主体，DEC-058 / 068）与 avoidSubjects（全部主体，DEC-329①）两个节点开关；
 * - 实例级：{发起人} ∪ 全部主体，不受开关影响（DEC-329②；异常管理员、管理员干预、交接、接管、提交预检）。
 * 账号来源的人（发起人、办理人、各类目标、异常管理员）只按账号与冻结的 U(S) 比较；员工来源的表达式候选另按人员 ID
 * 与 S 比较（设计 §2.3，R2-02）。比较前统一转小写，兼容不同大小写写法的 UUID（DEC-194）。
 */
import { avoidsSelf, avoidsSubjects, type NodeActions } from './types.js';

/** 实例冻结的回避事实（设计 §2.1）。 */
export interface RecusalFacts {
  readonly initiatorUserId: string;
  /** 单主体员工（approval_instances.subject_employee_id）。 */
  readonly primaryEmployeeId: string | null;
  /** 单主体账号：冻结值；存量实例（无冻结行）为实时绑定（设计 §2.1）。 */
  readonly primaryUserId: string | null;
  /** 主体员工集合 S（含单主体）。 */
  readonly subjectEmployeeIds: ReadonlySet<string>;
  /** 主体账号集合 U(S)（含单主体账号）。 */
  readonly subjectUserIds: ReadonlySet<string>;
}

/**
 * 被判定的人。personId 只用于员工来源的表达式候选（组织角色、任职记录上的人员）；账号来源的人不填（设计 §2.3）。
 */
export interface Who {
  readonly userId: string | null;
  readonly personId?: string | null;
}

/** 节点级命中：self = avoidSelf 命中（DEC-068 改派），subjects = avoidSubjects 命中（按节点配置自动处理）。 */
export type RecusalHit = 'self' | 'subjects' | null;

const lower = (id: string | null | undefined) => (id ? id.toLowerCase() : null);

/** 按规范小写建立回避事实，调用方不必关心来源的大小写写法。 */
export function recusalFacts(input: {
  readonly initiatorUserId: string;
  readonly primaryEmployeeId: string | null;
  readonly primaryUserId: string | null;
  readonly subjectEmployeeIds: Iterable<string>;
  readonly subjectUserIds: Iterable<string>;
}): RecusalFacts {
  const employees = new Set([...input.subjectEmployeeIds].map((id) => id.toLowerCase()));
  const users = new Set([...input.subjectUserIds].map((id) => id.toLowerCase()));
  const primaryEmployeeId = lower(input.primaryEmployeeId);
  const primaryUserId = lower(input.primaryUserId);
  if (primaryEmployeeId) employees.add(primaryEmployeeId);
  if (primaryUserId) users.add(primaryUserId);
  return {
    initiatorUserId: input.initiatorUserId.toLowerCase(),
    primaryEmployeeId,
    primaryUserId,
    subjectEmployeeIds: employees,
    subjectUserIds: users,
  };
}

function isInitiator(who: Who, facts: RecusalFacts): boolean {
  return lower(who.userId) === facts.initiatorUserId;
}

function isPrimary(who: Who, facts: RecusalFacts): boolean {
  const userId = lower(who.userId);
  const personId = lower(who.personId);
  return (
    (userId !== null && userId === facts.primaryUserId) || (personId !== null && personId === facts.primaryEmployeeId)
  );
}

function isSubject(who: Who, facts: RecusalFacts): boolean {
  const userId = lower(who.userId);
  const personId = lower(who.personId);
  return (
    (userId !== null && facts.subjectUserIds.has(userId)) ||
    (personId !== null && facts.subjectEmployeeIds.has(personId))
  );
}

/**
 * 节点级回避（设计 §2.4）：avoidSelf 先判（DEC-068 改派给真人审批，比自动跳过更严），再判 avoidSubjects。
 */
export function nodeRecusal(
  node: { readonly actions?: Pick<NodeActions, 'avoidSelf' | 'avoidSubjects'> },
  who: Who,
  facts: RecusalFacts,
): RecusalHit {
  if (avoidsSelf(node) && (isInitiator(who, facts) || isPrimary(who, facts))) return 'self';
  if (avoidsSubjects(node) && isSubject(who, facts)) return 'subjects';
  return null;
}

/**
 * 实例级回避（设计 §2.4，DEC-329②）：发起人 ∪ 全部主体，不受节点开关影响。
 * @param options.exemptInitiator IDP 计划所有者干预（DEC-321①）：发起人就是所有者本人，不回避
 */
export function instanceRecusal(
  who: Who,
  facts: RecusalFacts,
  options: { readonly exemptInitiator?: boolean } = {},
): boolean {
  if (!options.exemptInitiator && isInitiator(who, facts)) return true;
  return isSubject(who, facts);
}
