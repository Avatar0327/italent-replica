/**
 * 意向退休日期申请（R2-T04 §2.5 / §11，5d2）的纯规则：状态、按钮、字段目录与日期校验。
 * 意向申请不是任职记录（单表 + revision，不做版本链，设计 §2.5）；通过后只记录、不写回预计退休日期（A-6，DEC-637 / DEC-638）。
 */
import { EMPLOYEE_STATUS } from './employee-status.js';

/** 唯一新增的按钮（detail, create）：复用任职记录对象，不新建权限对象（设计 §11.1）。 */
export const RETIREMENT_INTENTION_BUTTON = 'Employment.RetireIntention';

export const RETIREMENT_INTENTION_STATES = [
  'draft',
  'in_review',
  'rejected',
  'approved',
  'disapproved',
  'withdrawn',
] as const;
export type RetirementIntentionState = (typeof RETIREMENT_INTENTION_STATES)[number];

/** 未办结：同员工至多一张（部分唯一索引同口径，设计 §2.5）。 */
export const RETIREMENT_INTENTION_OPEN_STATES: readonly RetirementIntentionState[] = ['draft', 'in_review', 'rejected'];

export const RETIREMENT_INTENTION_REASON_MAX = 500;

/** 可编辑业务字段（审批表单与字段权限共用）与只读快照字段（申请时冻结，设计 §11.2）。 */
export const RETIREMENT_INTENTION_EDITABLE_FIELDS = ['intendedDate', 'reason'] as const;
export const RETIREMENT_INTENTION_SNAPSHOT_FIELDS = [
  'expectedDateSnapshot',
  'earliestSnapshot',
  'latestSnapshot',
] as const;
export const RETIREMENT_INTENTION_FORM_FIELDS: readonly string[] = [
  ...RETIREMENT_INTENTION_EDITABLE_FIELDS,
  ...RETIREMENT_INTENTION_SNAPSHOT_FIELDS,
];

/** 申请时员工须处于这些人员状态（“当前在职”）；待入职、调出、待调入、退休、离职不可申请。 */
export const RETIREMENT_INTENTION_EMPLOYED_STATUSES: readonly number[] = [
  EMPLOYEE_STATUS.probation,
  EMPLOYEE_STATUS.regular,
  EMPLOYEE_STATUS.informal,
];

export type IntentionDateViolation = 'RETIREMENT_INTENTION_NOT_FUTURE' | 'RETIREMENT_INTENTION_OUT_OF_RANGE';

/**
 * 意向退休日期校验（设计 §11.1）：必须晚于今天；弹性上下限都存在时落在 [earliest, latest] 内，缺任一端则不限（A-6）。
 * 日期是租户业务日（YYYY-MM-DD），比较即字典序。
 */
export function intentionDateViolation(input: {
  readonly intendedDate: string;
  readonly today: string;
  readonly earliest: string | null;
  readonly latest: string | null;
}): IntentionDateViolation | null {
  if (input.intendedDate <= input.today) return 'RETIREMENT_INTENTION_NOT_FUTURE';
  if (input.earliest && input.latest && (input.intendedDate < input.earliest || input.intendedDate > input.latest))
    return 'RETIREMENT_INTENTION_OUT_OF_RANGE';
  return null;
}
