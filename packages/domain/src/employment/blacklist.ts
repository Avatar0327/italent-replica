/**
 * R2 BE-8a 黑名单（B68；docs/02_业务建模/30 DM-R2、34 OF-R2；DEC-569；差距表“补证结论 R2f”）。纯规则，不碰 IO：
 * 加黑原因选项、数据来源、有效判定、再入职拦截提示原文，以及离职自动加黑规则的匹配（多条命中取优先级数字最小者）。
 * 有效截止日期与加黑原因是两个独立字段：原因文案（如“当月离职人员不能当月再入职”）不推导期限。
 */

/** 加黑原因（必填），原站选项原文。 */
export const BLACKLIST_REASONS = {
  major_violation: '重大违纪',
  integrity: '诚信问题',
  instability: '稳定性差',
  resignation: '辞职',
  other: '其他(当月离职人员不能当月再入职)',
} as const;
export type BlacklistReason = keyof typeof BLACKLIST_REASONS;
export const BLACKLIST_REASON_CODES = Object.keys(BLACKLIST_REASONS) as [BlacklistReason, ...BlacklistReason[]];

/**
 * 数据来源：手动新增与离职表单勾选加黑在原站都显示“手工新增”（R2f2）；自动加黑与导入的显示文案未验证。
 * BE-8b 接线时：离职表单加黑写 manual，自动加黑写 auto_rule；导入未做（后补）。
 */
export const BLACKLIST_SOURCES = {
  manual: '手工新增',
  auto_rule: '自动加入',
  import: '导入',
} as const;
export type BlacklistSource = keyof typeof BLACKLIST_SOURCES;
export const BLACKLIST_SOURCE_CODES = Object.keys(BLACKLIST_SOURCES) as [BlacklistSource, ...BlacklistSource[]];

/** 黑名单记录状态：在名单 / 已移出（移出保留记录，删除则整行删除并在审计留快照）。 */
export const BLACKLIST_STATUSES = ['active', 'removed'] as const;
export type BlacklistStatus = (typeof BLACKLIST_STATUSES)[number];

export const BLACKLIST_NOTE_MAX = 500;
export const BLACKLIST_BATCH_LIMIT = 100;

/** 有效黑名单：在名单且有效截止日期为空（永久）或不早于判定日。 */
export function isBlacklistEffective(
  entry: { readonly status: string; readonly expiryDate: string | null },
  today: string,
): boolean {
  return entry.status === 'active' && (entry.expiryDate === null || entry.expiryDate >= today);
}

export function blacklistReasonLabel(reason: string): string {
  return (BLACKLIST_REASONS as Record<string, string>)[reason] ?? reason;
}

/** 再入职保存被拦时的提示原文（DEC-569 实测）。 */
export function blacklistBlockedMessage(name: string, reason: string): string {
  return `此人员已被列入黑名单（姓名：${name}，原因：${blacklistReasonLabel(reason)}），无法执行此操作`;
}

// ---- 离职自动加黑规则（规则页；DEC-569 页面提示：无论开关是否开启，黑名单人员无法重聘）----------------------------------

/** 总开关“离职后自动加入黑名单”（两层配置，系统值 false）。 */
export const AUTO_BLACKLIST_SETTING_KEY = 'exit.auto_blacklist_enabled';
export const isAutoBlacklistSettingValue = (value: unknown): boolean => typeof value === 'boolean';

/** 加黑期限：只实现已验证的两项；“指定期限”的后续字段未验证，接口拒绝（后补）。 */
export const BLACKLIST_RULE_TERMS = { permanent: '永久', exit_month: '离职当月' } as const;
export type BlacklistRuleTerm = keyof typeof BLACKLIST_RULE_TERMS;
export const BLACKLIST_RULE_TERM_CODES = Object.keys(BLACKLIST_RULE_TERMS) as [
  BlacklistRuleTerm,
  ...BlacklistRuleTerm[],
];

/** 加黑条件：只实现“离职次数 大于等于 N 次”；其他条件字段与运算符未验证，接口拒绝（后补）。 */
export const BLACKLIST_CONDITION_FIELDS = { exitCount: '离职次数' } as const;
export const BLACKLIST_CONDITION_OPERATORS = { gte: '大于等于' } as const;
export type BlacklistConditionField = keyof typeof BLACKLIST_CONDITION_FIELDS;
export type BlacklistConditionOperator = keyof typeof BLACKLIST_CONDITION_OPERATORS;

export const BLACKLIST_RULE_LIMIT = 100;
export const BLACKLIST_RULE_CONDITION_LIMIT = 10;
export const BLACKLIST_RULE_TEXT_MAX = 500;

export interface BlacklistCondition {
  readonly field: BlacklistConditionField;
  readonly operator: BlacklistConditionOperator;
  readonly value: number;
}

export interface BlacklistRuleFacts {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  /** 适用组织（含下级）：离职人员所在部门或其任一上级在其中即适用。 */
  readonly orgIds: readonly string[];
  readonly conditions: readonly BlacklistCondition[];
  readonly term: BlacklistRuleTerm;
  readonly reason: BlacklistReason;
  readonly note: string | null;
}

export interface AutoBlacklistCandidate {
  /** 离职次数（含本次离职），由 BE-8b 在离职生效时计算。 */
  readonly exitCount: number;
  /** 离职人员所在部门及其全部上级（行政维度）。 */
  readonly orgChain: readonly string[];
}

function conditionHolds(condition: BlacklistCondition, candidate: AutoBlacklistCandidate): boolean {
  const actual = candidate[condition.field];
  return condition.operator === 'gte' && actual >= condition.value;
}

/** 规则适用且条件同时满足的规则里取优先级数字最小者；同优先级按规则顺序取先者；都不满足返回 null。 */
export function matchBlacklistRule(
  rules: readonly BlacklistRuleFacts[],
  candidate: AutoBlacklistCandidate,
): BlacklistRuleFacts | null {
  const hits = rules
    .map((rule, index) => ({ rule, index }))
    .filter(
      ({ rule }) =>
        rule.orgIds.some((orgId) => candidate.orgChain.includes(orgId)) &&
        rule.conditions.every((condition) => conditionHolds(condition, candidate)),
    )
    .toSorted((a, b) => a.rule.priority - b.rule.priority || a.index - b.index);
  return hits[0]?.rule ?? null;
}
