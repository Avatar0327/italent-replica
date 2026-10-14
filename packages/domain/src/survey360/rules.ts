/**
 * 360 度评估的固定规则（docs/02_业务建模/25 §3；DEC-027 / DEC-033 / DEC-149）。纯常量，无 IO。
 */

/** 内置评价角色（E3-R4）；租户可扩展。顺序即默认显示顺序。 */
export const BUILTIN_ROLES = [
  { code: 'self', name: '自评' },
  { code: 'superior', name: '上级' },
  { code: 'peer', name: '同事' },
  { code: 'subordinate', name: '下级' },
  { code: 'customer', name: '客户' },
  { code: 'other', name: '其他' },
] as const;

export type BuiltinRoleCode = (typeof BUILTIN_ROLES)[number]['code'];
export const SELF_ROLE: BuiltinRoleCode = 'self';
/** 上级、同事、下级、其他只能从内部员工中选；客户可手工录入（E3-R19，请上级确认时适用）。 */
export const INTERNAL_ONLY_ROLES: readonly BuiltinRoleCode[] = ['superior', 'peer', 'subordinate', 'other'];

export const SURVEY360_LIMITS = {
  /** DEC-033：租户评价角色上限（含内置）。 */
  tenantRoles: 90,
  /** E3-R4 / DEC-033：单套卷最多 15 个角色（含自评）。 */
  rolesPerQuestionnaire: 15,
  /** E3-R6：选项最多 15 个。 */
  optionsPerScale: 15,
  /** E3-R3：一个评价对象 1–3 个套卷。 */
  questionnairesPerObject: 3,
  /** E3-R16：一个活动最多 30,000 个评价对象。 */
  objectsPerActivity: 30_000,
  /** E3-R17：一个评价对象最多 500 个评价者；一个活动最多 50,000 个评价者（按评价关系计）。 */
  appraisersPerObject: 500,
  appraisersPerActivity: 50_000,
  /** 批量导入单次上限（AGENTS.md §10「批量」）。 */
  importRows: 2_000,
} as const;

/**
 * DEC-149 / AC-360-16：「设置评价者」页常驻的不拦截提示（原站原文）。360 不设最少评价人数阈值，
 * 不按人数隐藏分数、人数或评语。
 */
export const ANONYMITY_HINT = '建议各评价角色至少3人（上级和自评除外），以增加匿名性和准确性';

/** 活动级匿名开关一：作答页评价角色的显示方式（原站“显示评价角色名称 / 显示固定文字 / 不显示”）。 */
export const ROLE_DISPLAY_MODES = ['name', 'fixed_text', 'hidden'] as const;
export type RoleDisplayMode = (typeof ROLE_DISPLAY_MODES)[number];
/** 角色未设固定文字时作答页显示的默认文字。 */
export const DEFAULT_ROLE_FIXED_TEXT = '评价者';

/**
 * Lastest360Cent 端口记录的字段名（`26` §8.1：分数字段 问卷-自评总分 / 他评总分 / 角色得分 / 维度、题目分；
 * 过滤 套卷名称、维度名称、题目名称、角色名称、活动名称）。`26` §8.6 / DEC-304 确认两个分数字段别名，
 * 原有维度、题目字段名保留以兼容旧公式。
 */
export const SURVEY360_FIELDS = {
  activityName: '活动名称',
  questionnaireName: '套卷名称',
  roleName: '角色名称',
  roleScore: '角色得分',
  selfTotal: '问卷-自评总分',
  otherTotal: '问卷-他评总分',
  dimensionName: '维度名称',
  dimensionSelf: '维度-自评分',
  dimensionOther: '维度-他评分',
  dimensionRole: '维度角色得分',
  questionName: '题目名称',
  questionSelf: '题目-自评分',
  questionOther: '题目-他评分',
  questionOtherTotal: '题目-他评总分',
} as const;
