/**
 * 试用期信息与转正日期的纯规则（R2 BE-3；docs/02_业务建模/29 §1、PB-R1 / R8 / R11 / R12，15 §5）。
 * 预计试用结束日 = 开始日 + 月数 − 1 天（R2e6、R2f1：10-16 + 1 个月 = 11-15）；
 * 默认转正日期 = 预计试用结束日的次日（F-205，原站 W-105b 手动转正、R2e7 自动转正同一口径）。
 * BE-15 的自动转正直接引用 defaultRegularizationDate，不另写一份。
 */
import { addDays, termEnd } from '../contracts/rules.js';

/** 试用期（月）取值：原站实习转正表单选项 1～6（R2f1），与劳动合同法试用期上限一致。 */
export const PROBATION_MONTHS_MIN = 1;
export const PROBATION_MONTHS_MAX = 6;

export function expectedProbationEndDate(startDate: string, months: number): string {
  return termEnd(startDate, months);
}

/** F-205：没填转正日期时的默认值（直接转正、转正申请、批量转正、BE-15 自动转正共用）。 */
export function defaultRegularizationDate(expectedEndDate: string): string {
  return addDays(expectedEndDate, 1);
}

/** 15 §5：实际试用结束日期 = 转正生效日期的前一天。 */
export function actualProbationEndDate(regularizationDate: string): string {
  return addDays(regularizationDate, -1);
}

/** 试用期管理视图（PB-R1）：即将试用到期、转正审批中、全部试用员工、已转正；“考核中”归 BE-15。 */
export const PROBATION_VIEWS = ['expiring', 'in_review', 'all', 'regularized'] as const;
export type ProbationView = (typeof PROBATION_VIEWS)[number];
/** PB-R1：即将试用到期 = 30 天内到期，默认范围今天到今天 + 30 天。 */
export const PROBATION_EXPIRING_DAYS = 30;

/** 试用结果字典的出厂项（DEC-361 种子）：与转正意见中会生成转正记录的三项一致（PB-R5），租户可改名、停用、新增。 */
export const PROBATION_RESULT_PRESETS: readonly { readonly code: string; readonly name: string }[] = [
  { code: 'normal', name: '正常转正' },
  { code: 'early', name: '提前转正' },
  { code: 'delayed', name: '延期转正' },
];

export interface ProbationInfo {
  readonly hasProbation: boolean;
  readonly startDate: string | null;
  readonly months: number | null;
  readonly expectedEndDate: string | null;
}

export interface ProbationAdjustment extends ProbationInfo {
  /** 调整试用信息表单上的“实际转正日期”；没有转正记录时为空。 */
  readonly regularizationDate: string | null;
}

/** 无试用期时其余字段一律为空；只给了月数时按开始日推算预计结束日（可手改，R2e6）。 */
export function normalizeProbationInfo(input: ProbationInfo): ProbationInfo {
  if (!input.hasProbation) return { hasProbation: false, startDate: null, months: null, expectedEndDate: null };
  const derived =
    input.expectedEndDate ??
    (input.startDate && input.months ? expectedProbationEndDate(input.startDate, input.months) : null);
  return { ...input, expectedEndDate: derived };
}

export type ProbationViolationReason =
  | 'PROBATION_DATES_REQUIRED'
  | 'PROBATION_START_BEFORE_ENTRY'
  | 'PROBATION_END_BEFORE_START'
  | 'PROBATION_REGULARIZED'
  | 'PROBATION_REGULARIZATION_DATE_REQUIRED'
  | 'PROBATION_REGULARIZATION_DATE_MISMATCH'
  | 'PROBATION_REGULARIZATION_DATE_WITHOUT_RECORD';

export interface ProbationViolation {
  readonly reason: ProbationViolationReason;
  readonly message: string;
  /** conflict = 与已有转正记录冲突（409）；其余为字段不合法（400）。 */
  readonly kind: 'conflict' | 'validation';
}

const violation = (
  reason: ProbationViolationReason,
  message: string,
  kind: ProbationViolation['kind'] = 'validation',
): ProbationViolation => ({ reason, message, kind });

/**
 * 调整试用信息的校验（PB-R11、PB-R12）。regularizationDate 是本任职周期“生效的转正任职记录”的日期——
 * 审批通过但未到生效日的也算（W-597）；没有则为 null。实际转正日期只能照转正记录填，不在这里另改一份。
 */
export function probationAdjustmentViolation(
  input: ProbationAdjustment,
  facts: { readonly entryDate: string; readonly regularizationDate: string | null },
): ProbationViolation | null {
  if (facts.regularizationDate) {
    if (!input.hasProbation)
      return violation('PROBATION_REGULARIZED', '该人员已存在生效的转正任职记录，不能改为无试用期', 'conflict');
    if (!input.regularizationDate)
      return violation(
        'PROBATION_REGULARIZATION_DATE_REQUIRED',
        '该人员已存在生效的转正任职记录，转正日期不允许清空',
        'conflict',
      );
    if (input.regularizationDate !== facts.regularizationDate)
      return violation('PROBATION_REGULARIZATION_DATE_MISMATCH', '实际转正日期须与转正任职记录的转正日期一致');
  } else if (input.regularizationDate) {
    return violation('PROBATION_REGULARIZATION_DATE_WITHOUT_RECORD', '没有转正任职记录，不能填写实际转正日期');
  }
  if (!input.hasProbation) return null;
  if (!input.startDate || !input.expectedEndDate)
    return violation('PROBATION_DATES_REQUIRED', '有试用期时须填写试用开始日期和预计试用结束日期');
  if (input.startDate < facts.entryDate)
    return violation('PROBATION_START_BEFORE_ENTRY', '试用开始日期不能早于入职日期');
  if (input.expectedEndDate < input.startDate)
    return violation('PROBATION_END_BEFORE_START', '预计试用结束日期不能早于试用开始日期');
  return null;
}
