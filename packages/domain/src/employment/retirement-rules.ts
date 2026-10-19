/**
 * R2-T04 §9.1 预计退休日期规则（纯函数，禁止 IO；DEC-640、DEC-638 A-4）。
 * 首版只有固定年龄规则（DEC-636 c4）；条件是原站五槽中复刻已有的四个固定槽位，每槽至多一条、只用 in
 * （多选值命中其一），槽位之间 AND；雇佣关系必填。用工形式、人员类别复刻没有对应字段，登记 F-263。
 */

export const RETIREMENT_RULE_PURPOSES = ['expected_date'] as const;
export type RetirementRulePurpose = (typeof RETIREMENT_RULE_PURPOSES)[number];
export const RETIREMENT_RULE_TYPES = ['fixed_age'] as const;
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
  { code: '10', name: '工人', displayOrder: 1 },
  { code: '20', name: '干部', displayOrder: 2 },
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
  /** 适用组织，已按“包含下级”展开（调用方负责）。 */
  readonly scopeOrgIds: readonly string[];
  readonly retirementAgeYears: number;
  readonly retirementAgeMonths: number;
  readonly conditions: readonly RetirementCondition[];
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

/** RT-R5：只看启用、purpose 相同的规则；组织范围 → 优先级升序 → 序号升序，命中第一条即停。 */
export function matchRule(
  rules: readonly RetirementRule[],
  person: RetirementPerson,
  purpose: RetirementRulePurpose = 'expected_date',
): RetirementRule | null {
  const ordered = rules
    .filter((rule) => rule.enabled && rule.purpose === purpose)
    .sort((a, b) => a.priority - b.priority || a.sequenceNo - b.sequenceNo);
  for (const rule of ordered) {
    if (person.orgId === null || !rule.scopeOrgIds.includes(person.orgId)) continue;
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
