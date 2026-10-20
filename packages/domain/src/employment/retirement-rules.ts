/**
 * R2-T04 §9.1 / §9.1A 预计退休日期与弹性范围规则（纯函数，禁止 IO；DEC-640、DEC-641、DEC-638 A-4）。
 * 规则类型：固定年龄（DEC-636 c4，只用于预计退休日期）与内置法定函数（5c1b，两种用途都可选用，见 retirement-statutory.ts）；
 * 条件是原站五槽中复刻已有的四个固定槽位，每槽至多一条、只用 in（多选值命中其一），槽位之间 AND；雇佣关系必填。
 * 用工形式、人员类别复刻没有对应字段，登记 F-263。
 */
import {
  IDENTITY_TYPE_CADRE,
  IDENTITY_TYPE_WORKER,
  STATUTORY_FUNCTIONS,
  statutoryEarliestDate,
  statutoryExpectedDate,
  statutoryLatestDate,
} from './retirement-statutory.js';

export const RETIREMENT_RULE_PURPOSES = ['expected_date', 'flexible_range'] as const;
export type RetirementRulePurpose = (typeof RETIREMENT_RULE_PURPOSES)[number];
export const RETIREMENT_RULE_TYPES = ['fixed_age', 'builtin'] as const;
export type RetirementRuleType = (typeof RETIREMENT_RULE_TYPES)[number];
export const RETIREMENT_RULE_LIMIT = 100;
export const RETIREMENT_AGE_YEARS = { min: 30, max: 80 } as const;
export const RETIREMENT_AGE_MONTHS = { min: 0, max: 11 } as const;

/** 固定槽位，数组顺序即展示 / 存储顺序（seq = 下标 + 1）。 */
export const RETIREMENT_CONDITION_FIELDS = ['gender', 'nationality', 'employType', 'identityType'] as const;
export type RetirementConditionField = (typeof RETIREMENT_CONDITION_FIELDS)[number];
export const RETIREMENT_CONDITION_LABELS: Readonly<Record<RetirementConditionField, string>> = {
  gender: '性别',
  nationality: '国籍',
  employType: '雇佣关系',
  identityType: '个人身份',
};
/** 原站“雇佣关系”必填（DEC-640②）。 */
export const RETIREMENT_REQUIRED_CONDITION: RetirementConditionField = 'employType';
/** 雇佣关系取值同任职周期字段 employType。 */
export const RETIREMENT_EMPLOY_TYPES = ['internal', 'intern', 'external'] as const;
export const RETIREMENT_CONDITION_VALUES_MAX = 50;

/** 个人身份字典标准项（DEC-640③）：编码 10 = 工人、20 = 干部。 */
export const RETIREMENT_IDENTITY_TYPE_PRESETS = [
  { code: IDENTITY_TYPE_WORKER, name: '工人', displayOrder: 1 },
  { code: IDENTITY_TYPE_CADRE, name: '干部', displayOrder: 2 },
] as const;

/** 三个租户配置项（两层配置）。 */
export const RETIREMENT_AUTO_EXPECTED_DATE_KEY = 'retirement.auto_expected_date';
export const RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY = 'retirement.auto_flexible_range';
export const RETIREMENT_UPCOMING_DAYS_KEY = 'retirement.upcoming_days';
export const isRetirementSwitchValue = (value: unknown): boolean => typeof value === 'boolean';
export const isRetirementUpcomingDays = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365;

export interface RetirementCondition {
  readonly fieldCode: RetirementConditionField;
  readonly operator: 'in';
  readonly values: readonly string[];
}

export interface RetirementRule {
  readonly id: string;
  readonly purpose: RetirementRulePurpose;
  readonly enabled: boolean;
  readonly priority: number;
  readonly sequenceNo: number;
  readonly ruleType: RetirementRuleType;
  /** 预置法定规则（DEC-641①）：排在自建规则之后。 */
  readonly preset?: boolean;
  /** 适用组织，已按“包含下级”展开（调用方负责）。 */
  readonly scopeOrgIds: readonly string[];
  /** 适用全公司（预置规则及其未改范围的复制件）：不看组织，员工主职部门为空也适用。 */
  readonly scopeAllOrgs?: boolean;
  /** 固定年龄规则的退休年龄；内置函数规则为空。 */
  readonly retirementAgeYears: number | null;
  readonly retirementAgeMonths: number | null;
  /** 内置函数规则选用的函数编码：expected_date 用 expectedFunction，flexible_range 用 earliestFunction / latestFunction。 */
  readonly expectedFunction?: string | null;
  readonly earliestFunction?: string | null;
  readonly latestFunction?: string | null;
  readonly conditions: readonly RetirementCondition[];
}

/** 计算时点的人事当前值：出生日期与当前预计退休日期 P（已核准或未核准都用当前值，DEC-641 边角 b/c）。 */
export interface RetirementFacts {
  readonly birthday: string | null;
  readonly expectedDate: string | null;
}

/** 计算时点的人事最新版本与当前主职任职快照。 */
export interface RetirementPerson {
  readonly orgId: string | null;
  readonly gender: string | null;
  readonly nationality: string | null;
  readonly employType: string | null;
  readonly identityType: string | null;
}

function satisfies(condition: RetirementCondition, person: RetirementPerson): boolean {
  const value = person[condition.fieldCode];
  return value !== null && condition.values.includes(value);
}

function inScope(rule: RetirementRule, person: RetirementPerson): boolean {
  if (rule.scopeAllOrgs) return true;
  return person.orgId !== null && rule.scopeOrgIds.includes(person.orgId);
}

/**
 * RT-R5：只看启用、purpose 相同的规则；自建规则先于预置规则，其内按组织范围 → 优先级升序 → 序号升序，
 * 命中第一条即停（DEC-641①：自建命中优先）。
 */
export function matchRule(
  rules: readonly RetirementRule[],
  person: RetirementPerson,
  purpose: RetirementRulePurpose = 'expected_date',
): RetirementRule | null {
  const ordered = rules
    .filter((rule) => rule.enabled && rule.purpose === purpose)
    .sort(
      (a, b) =>
        Number(a.preset === true) - Number(b.preset === true) || a.priority - b.priority || a.sequenceNo - b.sequenceNo,
    );
  for (const rule of ordered) {
    if (!inScope(rule, person)) continue;
    if (rule.conditions.every((condition) => satisfies(condition, person))) return rule;
  }
  return null;
}

/**
 * 预计退休日期 = 出生日期 + 年龄（年月合并成总月数），再取目标月月末（A-4；2-29 → 平年 2-28）。
 * 出生日期为空或不是合法日期 → 空。
 */
export function expectedDateOf(birthday: string | null, years: number, months: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday ?? '');
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  const total = year * 12 + (month - 1) + years * 12 + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(targetYear, 4)}-${pad(targetMonth, 2)}-${pad(lastDay, 2)}`;
}

const EXPECTED_FUNCTIONS: Readonly<
  Record<string, (person: RetirementPerson, facts: RetirementFacts) => string | null>
> = {
  [STATUTORY_FUNCTIONS.expectedDate]: (person, facts) =>
    statutoryExpectedDate(facts.birthday, person.gender, person.identityType),
};
const EARLIEST_FUNCTIONS: Readonly<
  Record<string, (person: RetirementPerson, facts: RetirementFacts) => string | null>
> = {
  [STATUTORY_FUNCTIONS.earliest]: (person, facts) =>
    statutoryEarliestDate(facts.birthday, person.gender, person.identityType, facts.expectedDate),
};
const LATEST_FUNCTIONS: Readonly<Record<string, (person: RetirementPerson, facts: RetirementFacts) => string | null>> =
  {
    [STATUTORY_FUNCTIONS.latest]: (_person, facts) => statutoryLatestDate(facts.expectedDate),
  };

/** 命中规则后的预计退休日期：固定年龄规则取月末（A-4），内置函数规则按其函数（DEC-641①）；规则没有可用的取值方式 → 空。 */
export function expectedDateByRule(
  rule: RetirementRule,
  person: RetirementPerson,
  facts: RetirementFacts,
): string | null {
  if (rule.ruleType === 'fixed_age')
    return expectedDateOf(facts.birthday, rule.retirementAgeYears ?? 0, rule.retirementAgeMonths ?? 0);
  return EXPECTED_FUNCTIONS[rule.expectedFunction ?? '']?.(person, facts) ?? null;
}

/** 按 purpose = expected_date 匹配并计算：无命中 → null（由调用方决定是否清空）；命中但算不出（缺出生日期等）→ date 为 null。 */
export function resolveExpectedDate(
  rules: readonly RetirementRule[],
  person: RetirementPerson,
  facts: RetirementFacts,
): { readonly rule: RetirementRule; readonly date: string | null } | null {
  const rule = matchRule(rules, person, 'expected_date');
  return rule && { rule, date: expectedDateByRule(rule, person, facts) };
}

/**
 * 按 purpose = flexible_range 匹配并计算上下限：P 为空 → 上下限都空（RT-R6、A-20，与 normalizeRetirementRange 一致）；
 * 无命中 → null。弹性范围规则只选内置函数（DEC-640①），上下限各自空值由函数决定（如女性个人身份为空时最早留空）。
 */
export function resolveFlexibleRange(
  rules: readonly RetirementRule[],
  person: RetirementPerson,
  facts: RetirementFacts,
): { readonly rule: RetirementRule; readonly earliest: string | null; readonly latest: string | null } | null {
  const rule = matchRule(rules, person, 'flexible_range');
  if (!rule) return null;
  if (!facts.expectedDate) return { rule, earliest: null, latest: null };
  return {
    rule,
    earliest: EARLIEST_FUNCTIONS[rule.earliestFunction ?? '']?.(person, facts) ?? null,
    latest: LATEST_FUNCTIONS[rule.latestFunction ?? '']?.(person, facts) ?? null,
  };
}
