/**
 * 试用期考核对象的纯规则（R2 BE-15b1；docs/02_业务建模/29 §1、PB-R3～R6、PB-R9，差距表 B2 / B59）。
 * - 两类考核：试用中考核 / 转正考核，各一条审批流（员工自评 → 经理评价）；
 * - 转正意见只对审批人审批时选择的意见生效（PB-R6）：审批完成的那一刻按意见决定是否生成转正任职记录，
 *   审批通过后再改意见不补生成、不修改（assessmentRegularization 只在审批回调里调用）；
 * - 并行规则（PB-R9 例外）：两个开关 + “可发起流程”多选，出厂都关，由互斥检查点读取。
 */

export const ASSESSMENT_TYPES = { probation: '试用中考核', regularization: '转正考核' } as const;
export type AssessmentType = keyof typeof ASSESSMENT_TYPES;
export const ASSESSMENT_TYPE_CODES = Object.keys(ASSESSMENT_TYPES) as [AssessmentType, ...AssessmentType[]];

/** 考核记录状态：审批中 / 审批通过（= 生效）/ 驳回 / 不通过（不同意）/ 作废（撤回、删除）。 */
export const ASSESSMENT_STATUSES = {
  in_review: '审批中',
  approved: '审批通过',
  rejected: '已驳回',
  disapproved: '不通过',
  cancelled: '已作废',
} as const;
export type AssessmentStatus = keyof typeof ASSESSMENT_STATUSES;

/** 经理评价（PB-1 §1）。 */
export const ASSESSMENT_RATINGS = {
  average: '表现一般',
  meets: '满足预期',
  exceeds: '超出预期',
  below: '未达到预期',
} as const;
export type AssessmentRating = keyof typeof ASSESSMENT_RATINGS;
export const ASSESSMENT_RATING_CODES = Object.keys(ASSESSMENT_RATINGS) as [AssessmentRating, ...AssessmentRating[]];

/** 转正意见（§1）：正常转正 / 提前转正 / 延期转正 / 不通过 / 延期试用。 */
export const ASSESSMENT_OPINIONS = {
  normal: '正常转正',
  early: '提前转正',
  delayed: '延期转正',
  failed: '不通过',
  extended: '延期试用',
} as const;
export type AssessmentOpinion = keyof typeof ASSESSMENT_OPINIONS;
export const ASSESSMENT_OPINION_CODES = Object.keys(ASSESSMENT_OPINIONS) as [AssessmentOpinion, ...AssessmentOpinion[]];

/** 考核字段（对象 TenantBase.ProbationAssessment 的字段目录；审批表单取其中的业务字段）。 */
export const ASSESSMENT_FORM_FIELDS = [
  'assessmentName',
  'assessmentDate',
  'selfEvaluation',
  'managerRating',
  'regularizationOpinion',
  'regularizationDate',
] as const;
export const ASSESSMENT_FIELDS = ['employeeId', 'assessmentType', ...ASSESSMENT_FORM_FIELDS] as const;
/** 只经命令写入的系统字段（只可查看）。 */
export const ASSESSMENT_SYSTEM_FIELDS = [
  'status',
  'initiation',
  'initiatorUserId',
  'regularizationBusinessId',
] as const;
/** 按钮（详情级，同 Employment.Create / Employment.Edit 的写入口形态）：发起考核、审批通过后修改。 */
export const ASSESSMENT_BUTTONS = { create: 'Assessment.Create', update: 'Assessment.Edit' } as const;

export const ASSESSMENT_NAME_MAX = 100;
export const ASSESSMENT_TEXT_MAX = 2000;
export const MAX_BATCH_ASSESSMENT = 100;
export const PROBATION_ASSESSMENT_OBJECT = 'TenantBase.ProbationAssessment';

export interface AssessmentOpinionFacts {
  readonly type: AssessmentType;
  readonly opinion: AssessmentOpinion | null;
  /** 提前转正日期 / 延期转正日期（正常转正可不填，取默认转正日期）。 */
  readonly regularizationDate: string | null;
}

/** 要求转正日期的意见（提前 / 延期转正）：没填日期的组合不能保存。 */
export const OPINIONS_REQUIRING_DATE: readonly AssessmentOpinion[] = ['early', 'delayed'];

/** 保存时的跨字段校验：返回不合法的原因（reason 编码 + 文案），合法返回 null。 */
export function assessmentOpinionViolation(
  facts: AssessmentOpinionFacts,
): { readonly reason: string; readonly message: string } | null {
  if (facts.opinion && OPINIONS_REQUIRING_DATE.includes(facts.opinion) && !facts.regularizationDate)
    return { reason: 'ASSESSMENT_DATE_REQUIRED', message: '提前转正 / 延期转正须填写转正日期' };
  return null;
}

export interface AssessmentRegularizationPlan {
  readonly generate: boolean;
  /** 空 = 取默认转正日期（预计试用结束日次日，F-205）。 */
  readonly effectiveDate: string | null;
  /** 试用结果字典编码（PROBATION_RESULT_PRESETS）。 */
  readonly probationResult: 'normal' | 'early' | 'delayed' | null;
}

const NONE: AssessmentRegularizationPlan = { generate: false, effectiveDate: null, probationResult: null };

/**
 * PB-R4 / PB-R5：审批完成时按审批人选择的意见决定是否生成转正任职记录。
 * 试用中考核：只有“提前转正”生成（生效日 = 提前转正日期，到期自动生效）；
 * 转正考核：正常 / 提前 / 延期转正生成，不通过、延期试用不生成（正常转正没填日期取默认转正日期）。
 */
export function assessmentRegularization(facts: AssessmentOpinionFacts): AssessmentRegularizationPlan {
  const { type, opinion, regularizationDate } = facts;
  if (!opinion) return NONE;
  if (type === 'probation')
    return opinion === 'early' ? { generate: true, effectiveDate: regularizationDate, probationResult: 'early' } : NONE;
  if (opinion === 'normal') return { generate: true, effectiveDate: regularizationDate, probationResult: 'normal' };
  if (opinion === 'early' || opinion === 'delayed')
    return { generate: true, effectiveDate: regularizationDate, probationResult: opinion };
  return NONE;
}

/** 审批中的考核对应的 PB-R9 流程名（并行规则“可发起流程”多选的取值）。 */
export const PARALLEL_PROCESSES = {
  probation_assessment: '试用中考核',
  regularization_assessment: '转正考核',
  regularization: '转正',
} as const;
export type ParallelProcess = keyof typeof PARALLEL_PROCESSES;

/** 并行规则的两个开关：以“审批中的流程”为单位，勾选的流程在它审批中时仍可发起（PB-R9 例外，AC-PB-10）。 */
export const PARALLEL_RULE_KEYS = {
  probation_assessment: 'probation.assessment_parallel.probation_assessment',
  regularization_assessment: 'probation.assessment_parallel.regularization_assessment',
} as const;
export type ParallelRuleBlocker = keyof typeof PARALLEL_RULE_KEYS;

/**
 * “可发起流程”候选：转正考核这一项的候选是转正考核、转正；试用中考核这一项，页面说明列了试用中考核、转正考核、转正
 * （下拉候选原站未读到，取说明里的三项，PB-R9）。
 */
export const PARALLEL_CANDIDATES: Readonly<Record<ParallelRuleBlocker, readonly ParallelProcess[]>> = {
  probation_assessment: ['probation_assessment', 'regularization_assessment', 'regularization'],
  regularization_assessment: ['regularization_assessment', 'regularization'],
};

export interface ParallelRule {
  readonly enabled: boolean;
  readonly allowed: readonly ParallelProcess[];
}
/** 出厂两项都关（PB-R9，R2e5 / §7 本租户配置）。 */
export const PARALLEL_RULE_DEFAULT: ParallelRule = { enabled: false, allowed: [] };

/** 两层配置取值校验：严格对象 { enabled, allowed }，allowed 只能取本开关的候选且不重复。 */
export function isParallelRuleValue(blocker: ParallelRuleBlocker, value: unknown): value is ParallelRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== 'allowed,enabled') return false;
  const { enabled, allowed } = record;
  if (typeof enabled !== 'boolean' || !Array.isArray(allowed)) return false;
  const candidates: readonly unknown[] = PARALLEL_CANDIDATES[blocker];
  return allowed.every((item) => candidates.includes(item)) && new Set(allowed).size === allowed.length;
}

/**
 * PB-R9 互斥校验的入口动作：regularize = 直接转正；apply = 提交转正申请；adjust = 调整试用信息；
 * assess_probation / assess_regularization = 发起试用中考核 / 转正考核。
 */
export type ProbationProcessAction = 'regularize' | 'apply' | 'adjust' | 'assess_probation' | 'assess_regularization';

/** 以 action 发起的流程：直接转正、转正申请都算“转正”；调整试用期不是流程发起，没有并行例外。 */
export function processOfAction(action: ProbationProcessAction): ParallelProcess | null {
  switch (action) {
    case 'regularize':
    case 'apply':
      return 'regularization';
    case 'assess_probation':
      return 'probation_assessment';
    case 'assess_regularization':
      return 'regularization_assessment';
    case 'adjust':
      return null;
  }
}

/** PB-R9：某审批中的考核是否放行这次发起（开关打开且勾选了这个流程）。 */
export function parallelAllows(rule: ParallelRule, process: ParallelProcess | null): boolean {
  return rule.enabled && process !== null && rule.allowed.includes(process);
}
