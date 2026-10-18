/**
 * 自动发起试用期考核的纯规则（R2 BE-15b2；docs/02_业务建模/29 PB-R16 / R17 / R19 / R20 / R21，差距表 B58，补证结论 R2e6）。
 * - 触发（PB-R17，AC-PB-06）：入职日 + 入职后天数 N = 当天才发起，过了不补发——与自动转正“目标日 ≤ 当天补发”不同；
 * - 失败（PB-R20）：本任职周期已有审批中 / 通过 / 生效的转正记录，或审批中的考核；
 * - 自动转正的考核类失败条件（PB-R21 考核部分）也在这里：本任职周期里的考核按（类型、状态、意见）判断是否阻断。
 */
import { addDays } from '../contracts/rules.js';
import type { AutoRegularizationRuleFacts } from './auto-regularization.js';
import type { AssessmentOpinion, AssessmentStatus, AssessmentType } from './assessment.js';

/** 总开关“自动发起试用期考核”（两层配置，系统值关闭；经 /api/tenant/settings/:key 读写）。 */
export const AUTO_ASSESSMENT_SETTING_KEY = 'probation.auto_assessment_enabled';
export const isAutoAssessmentSettingValue = (value: unknown): boolean => typeof value === 'boolean';

export const AUTO_ASSESSMENT_DAYS_MIN = 1;
export const AUTO_ASSESSMENT_DAYS_MAX = 999;
/** R2e6 原站提示原文（0、空值、越界、非整数同一句）。 */
export const AUTO_ASSESSMENT_DAYS_MESSAGE = '请设置1至999的整数';
export const AUTO_ASSESSMENT_RULE_LIMIT = 100;

export function isAutoAssessmentDays(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= AUTO_ASSESSMENT_DAYS_MIN &&
    (value as number) <= AUTO_ASSESSMENT_DAYS_MAX
  );
}

/** 目标日 = 入职日 + 入职后天数；只有目标日 = 当天才发起（不补发）。 */
export function autoAssessmentTargetDate(entryDate: string, daysAfterEntry: number): string {
  return addDays(entryDate, daysAfterEntry);
}

/**
 * 命中规则：适用组织包含主职部门、且目标日 = 当天的启用规则里取排在最前的一条（规则须已按优先级、登记顺序排好）。
 * 与自动转正不同，一人可同时落在多条规则的范围里（如入职第 30 天试用中考核、第 80 天转正考核），按“今天是不是它的第 N 天”分别触发。
 */
export function matchAutoAssessmentRule<T extends AutoRegularizationRuleFacts & { readonly daysAfterEntry: number }>(
  rules: readonly T[],
  departmentId: string | null,
  entryDate: string,
  today: string,
): T | null {
  if (!departmentId) return null;
  return (
    rules.find(
      (rule) =>
        rule.enabled &&
        rule.scopeOrgIds.includes(departmentId) &&
        autoAssessmentTargetDate(entryDate, rule.daysAfterEntry) === today,
    ) ?? null
  );
}

/** PB-R20：转正记录处于这些状态时自动考核失败（草稿 / 驳回 / 不通过 / 作废 / 已删除不算，原站条件未列）。 */
export const AUTO_ASSESSMENT_BLOCKING_REGULARIZATION_STATES = ['in_review', 'approved', 'effective'] as const;

export interface CycleAssessmentFacts {
  readonly type: AssessmentType;
  readonly status: AssessmentStatus;
  readonly opinion: AssessmentOpinion | null;
}

/**
 * PB-R21 考核部分：这条考核是否让自动转正失败。
 * - 转正考核：草稿 / 驳回 / 审批中 / 不通过 / 作废，或审批通过但意见 ≠ 正常转正（本系统没有草稿状态）；
 * - 试用中考核：审批中，或审批通过且意见 = 提前转正。
 */
export function assessmentBlocksAutoRegularization(facts: CycleAssessmentFacts): boolean {
  if (facts.type === 'probation')
    return facts.status === 'in_review' || (facts.status === 'approved' && facts.opinion === 'early');
  return facts.status !== 'approved' || facts.opinion !== 'normal';
}
