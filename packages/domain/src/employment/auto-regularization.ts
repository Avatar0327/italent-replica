/**
 * 自动转正规则的纯规则（R2 BE-15a；docs/02_业务建模/29 PB-R16 / R18 / R19 / R21，差距表 B57、补证结论 R2e7）。
 * - 目标日 = 预计试用结束日 − 到期前 N 天（N 取 0～999，R2e6）；每次执行发起所有目标日 ≤ 当天的人（补发，R2e7 样本二）；
 * - 转正日期不在这里算：发起时交 BE-3 的转正入口，按 defaultRegularizationDate 取预计结束日次日（F-205）；
 * - 多条规则命中同一人时取优先级数字最小的一条，同优先级取先登记者（同自动加黑规则 B68 的口径）。
 */
import { addDays } from '../contracts/rules.js';

/** 总开关“自动转正”（两层配置，系统值关闭；经 /api/tenant/settings/:key 读写）。 */
export const AUTO_REGULARIZATION_SETTING_KEY = 'probation.auto_regularization_enabled';
export const isAutoRegularizationSettingValue = (value: unknown): boolean => typeof value === 'boolean';

/** 业务处理规则（PB-R18）：自动转正 = 直接生成转正记录；自动发起转正申请 = 建申请并提交审批。 */
export const AUTO_REGULARIZATION_MODES = { direct: '自动转正', application: '自动发起转正申请' } as const;
export type AutoRegularizationMode = keyof typeof AUTO_REGULARIZATION_MODES;
export const AUTO_REGULARIZATION_MODE_CODES = Object.keys(AUTO_REGULARIZATION_MODES) as [
  AutoRegularizationMode,
  ...AutoRegularizationMode[],
];

/**
 * 发起人类型（R2e6 / R2e7）：当前管理员 = 最后保存该规则的管理员（R2e7 样本显示当前管理员）；
 * 按身份取员工当前主职部门的 HRBP / 负责人（组织上的结构化人员引用，经账号绑定落到用户）。
 */
export const AUTO_RULE_INITIATORS = {
  rule_operator: '当前管理员',
  department_hrbp: '主职部门 HRBP',
  department_head: '主职部门负责人',
} as const;
export type AutoRuleInitiator = keyof typeof AUTO_RULE_INITIATORS;
export const AUTO_RULE_INITIATOR_CODES = Object.keys(AUTO_RULE_INITIATORS) as [
  AutoRuleInitiator,
  ...AutoRuleInitiator[],
];

export const AUTO_REGULARIZATION_DAYS_MIN = 0;
export const AUTO_REGULARIZATION_DAYS_MAX = 999;
/** R2e6 原站提示原文（空值、越界、非整数同一句）。 */
export const AUTO_REGULARIZATION_DAYS_MESSAGE = '请设置0至999的整数';
export const AUTO_REGULARIZATION_RULE_LIMIT = 100;

export function isAutoRegularizationDays(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= AUTO_REGULARIZATION_DAYS_MIN &&
    (value as number) <= AUTO_REGULARIZATION_DAYS_MAX
  );
}

/** 目标日：到期前 N 天（N = 0 即到期当天）。 */
export function autoRegularizationTargetDate(expectedEndDate: string, daysBefore: number): string {
  return addDays(expectedEndDate, -daysBefore);
}

export interface AutoRegularizationRuleFacts {
  readonly id: string;
  readonly enabled: boolean;
  /** 已按“包含下级”展开的适用组织。 */
  readonly scopeOrgIds: readonly string[];
}

/** 规则须已按优先级、登记顺序排好；停用的规则不命中（DEC-533②）。 */
export function matchAutoRegularizationRule<T extends AutoRegularizationRuleFacts>(
  rules: readonly T[],
  departmentId: string | null,
): T | null {
  if (!departmentId) return null;
  return rules.find((rule) => rule.enabled && rule.scopeOrgIds.includes(departmentId)) ?? null;
}

/**
 * PB-R21 自动转正失败条件里的转正记录状态：本任职周期存在已驳回 / 不通过 / 作废 / 审批中 / 通过 / 生效的转正业务即失败。
 * 草稿与已删除不算（原站条件未列）。考核类条件随 BE-15b 的考核对象登记。
 */
export const AUTO_REGULARIZATION_BLOCKING_STATES = [
  'rejected',
  'disapproved',
  'voided',
  'in_review',
  'approved',
  'effective',
] as const;

/**
 * 每日批次时点（DEC-539①）：租户本地 04:00 之后的第一次调度（R2e7 原站北京 04:45 执行，复刻不对齐到分钟）。
 * 定时生效在午夜后先落地，再发起自动转正。
 */
export const AUTO_REGULARIZATION_LOCAL_HOUR = 4;
