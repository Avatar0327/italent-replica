/**
 * 兼职的区间、任职状态、视图归属与主职周期边界（docs/08_设计/R2-T05_兼职设计.md §1.2 / §4.3 / §4.3A / §4.6 / §4.7 / §6.1）。
 * 纯函数、无 IO：日期是租户业务日（YYYY-MM-DD，DEC-056），比较即字典序；区间含两端，endDate = null 表示无结束日期。
 * SQL 镜像在 apps/api/src/modules/employment/part-time/span-sql.ts，逐点等价由 AC-PT-span-sql 断言。
 */
import { addDays } from '../contracts/rules.js';
import { EMPLOYEE_STATUS } from './employee-status.js';
import { PART_TIME_ERRORS, type PartTimeServiceType } from './part-time-constants.js';

export interface PartTimeSpan {
  readonly startDate: string;
  /** 期限链当前期的结束日期（含当天）。 */
  readonly endDate: string | null;
}

/** 空区间（end = start − 1，“未开始即终止”）：只由离职 / 调动联动写出（§1.2）。 */
export function isEmptyPartTimeSpan(span: PartTimeSpan): boolean {
  return span.endDate !== null && span.endDate < span.startDate;
}

/** 任职状态（原站 ServiceStatus）：空区间或结束日已过 → 任职结束；未来开始仍是任职中（W-611 / W-612）。 */
export const PART_TIME_SERVICE_STATUSES = ['serving', 'ended'] as const;
export type PartTimeServiceStatus = (typeof PART_TIME_SERVICE_STATUSES)[number];
export const PART_TIME_SERVICE_STATUS_LABELS: Readonly<Record<PartTimeServiceStatus, string>> = {
  serving: '任职中',
  ended: '任职结束',
};

export function partTimeServiceStatus(span: PartTimeSpan, today: string): PartTimeServiceStatus {
  return isEmptyPartTimeSpan(span) || (span.endDate !== null && span.endDate < today) ? 'ended' : 'serving';
}

/** 当前生效：非空区间且 start ≤ today ≤ end（W-612 / W-613）。结束日当天仍生效，次日起结束，无需定时任务。 */
export function isPartTimeCurrent(span: PartTimeSpan, today: string): boolean {
  return span.startDate <= today && (span.endDate === null || today <= span.endDate);
}

/**
 * 六视图（§6.1）。in_approval 按兼职申请判定，其余按记录；视图之间允许重叠（即将到期 ⊂ 兼职中）。
 * 视图归属与任职状态是两个维度：未开始视图里的记录任职状态仍是“任职中”（R2d）。
 */
export const PART_TIME_VIEWS = ['ongoing', 'expiring', 'not_started', 'ended', 'all', 'in_approval'] as const;
export type PartTimeView = (typeof PART_TIME_VIEWS)[number];
export type PartTimeRecordView = Exclude<PartTimeView, 'in_approval'>;
export const PART_TIME_RECORD_VIEWS: readonly PartTimeRecordView[] = [
  'ongoing',
  'expiring',
  'not_started',
  'ended',
  'all',
];
/** 即将到期取 [today, today + days]；第 30 天是否含未验证（§12 B-1），取含。 */
export const PART_TIME_EXPIRING_DAYS = { default: 30, min: 1, max: 365 } as const;

export function inPartTimeView(
  view: PartTimeRecordView,
  span: PartTimeSpan,
  today: string,
  expiringDays: number = PART_TIME_EXPIRING_DAYS.default,
): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'ongoing':
      return isPartTimeCurrent(span, today);
    case 'expiring':
      return isPartTimeCurrent(span, today) && span.endDate !== null && span.endDate <= addDays(today, expiringDays);
    case 'not_started':
      return !isEmptyPartTimeSpan(span) && span.startDate > today;
    case 'ended':
      return partTimeServiceStatus(span, today) === 'ended';
  }
}

export function partTimeViews(
  span: PartTimeSpan,
  today: string,
  expiringDays: number = PART_TIME_EXPIRING_DAYS.default,
): PartTimeRecordView[] {
  return PART_TIME_RECORD_VIEWS.filter((view) => inPartTimeView(view, span, today, expiringDays));
}

/** 借调 / 外派同时只能有一条未结束（W-616；借调未单独实测，按三类合并推断，Q-M0-121②；返聘不在本单）。 */
export const PART_TIME_EXCLUSIVE_TYPES: readonly PartTimeServiceType[] = ['secondment', 'expatriate'];
const isExclusive = (serviceType: string) => (PART_TIME_EXCLUSIVE_TYPES as readonly string[]).includes(serviceType);

export interface ExclusivePartTimeFacts {
  /** 本次新增的任职类型。 */
  readonly serviceType: string;
  /** 该员工的全部兼职记录（当前期）。 */
  readonly records: readonly (PartTimeSpan & { readonly serviceType: string })[];
  /** 草稿 / 审批中 / 驳回的新增申请的任职类型（复刻从严：在途申请也占用，A-7）。 */
  readonly pending: readonly string[];
  readonly today: string;
}

/** D-5：true = 409 PART_TIME_EXCLUSIVE_TYPE_EXISTS；普通兼职不做重叠 / 重复校验（D-6，W-614）。 */
export function exclusivePartTimeConflict(facts: ExclusivePartTimeFacts): boolean {
  if (!isExclusive(facts.serviceType)) return false;
  return (
    facts.records.some(
      (record) => isExclusive(record.serviceType) && partTimeServiceStatus(record, facts.today) !== 'ended',
    ) || facts.pending.some(isExclusive)
  );
}

/** 主职周期的终止业务：其最后工作日是兼职区间的上界（§4.3A）。 */
export const PART_TIME_TERMINATION_KINDS: readonly string[] = ['leave', 'retirement'];
/** 开始日主职须处于这些人员状态；待入职 1、调出 4、待调入 5、退休 6、离职 8 拒绝（A-8）。 */
const ACTIVE_STATUSES: readonly number[] = [
  EMPLOYEE_STATUS.probation,
  EMPLOYEE_STATUS.regular,
  EMPLOYEE_STATUS.informal,
];

export interface PartTimeBoundaryInput extends PartTimeSpan {
  /** F1：开始日的主职时间轴当前记录（所在周期、业务类型、人员状态）；开始日没有主职记录为 null。 */
  readonly primary: { readonly staffId: string; readonly kind: string; readonly employeeStatus: number } | null;
  /** 已有兼职记录时为记录所属周期：开始日主职须仍在该周期。新建时省略，由 F1 决定周期。 */
  readonly recordStaffId?: string | null;
  /** F2：该周期已生效（已落地）的离职 / 退休中最早一条的实际生效日 E（迟到顺延后即 E′）。 */
  readonly exitEffectiveDate: string | null;
  /** F3：该周期审批中 / 已批准未落地的离职 / 退休中最早的计划生效日（R2-T03 §5.0A 唯一来源）。 */
  readonly pendingExitPlannedDate: string | null;
  /** 编辑兼职时仅提前结束日（isPartTimeEndShortened）：跳过 B-3，B-1 / B-2 / B-4 照常（DEC-624）。 */
  readonly shortenOnly?: boolean;
}

export type PartTimeBoundaryReason =
  typeof PART_TIME_ERRORS.primaryNotActive | typeof PART_TIME_ERRORS.beyondExit | typeof PART_TIME_ERRORS.afterExit;

export interface PartTimeBoundaryOutcome {
  /** 409 的业务原因；lastWorkDate 是越过的最后工作日（L 或 Lp），供提示文案与 detail。 */
  readonly violation: { readonly reason: PartTimeBoundaryReason; readonly lastWorkDate?: string } | null;
  /** 只提示不拦（B-4，W-610）：离职落地时由钩子结束兼职。 */
  readonly warnings: readonly (typeof PART_TIME_ERRORS.spansPendingExit)[];
}

/**
 * §4.3A 唯一判定（B-1～B-4）：所有写兼职区间的人工入口都经它；系统入口只缩短区间，不调用。
 * 越过已生效离职一律拒绝、不自动截断（A-16）；撤销离职后 F2 随时间轴记录消失，边界随之解除。
 */
export function partTimeBoundaryViolation(input: PartTimeBoundaryInput): PartTimeBoundaryOutcome {
  const primary = input.primary;
  if (
    !primary ||
    PART_TIME_TERMINATION_KINDS.includes(primary.kind) ||
    !ACTIVE_STATUSES.includes(primary.employeeStatus) ||
    (input.recordStaffId != null && input.recordStaffId !== primary.staffId)
  )
    return { violation: { reason: PART_TIME_ERRORS.primaryNotActive }, warnings: [] };
  if (input.exitEffectiveDate !== null) {
    const lastWorkDate = addDays(input.exitEffectiveDate, -1);
    if (input.endDate === null || input.endDate > lastWorkDate)
      return { violation: { reason: PART_TIME_ERRORS.beyondExit, lastWorkDate }, warnings: [] };
  }
  if (input.pendingExitPlannedDate !== null) {
    const lastWorkDate = addDays(input.pendingExitPlannedDate, -1);
    if (!input.shortenOnly && input.startDate > lastWorkDate)
      return { violation: { reason: PART_TIME_ERRORS.afterExit, lastWorkDate }, warnings: [] };
    if (input.endDate === null || input.endDate > lastWorkDate)
      return { violation: null, warnings: [PART_TIME_ERRORS.spansPendingExit] };
  }
  return { violation: null, warnings: [] };
}

/**
 * 编辑兼职是否只把结束日提前：原结束日为空改为有限日期，或新结束日早于原结束日（DEC-624，F-236）。
 * 相等（未改）与延长 / 改回更晚都不算，仍走完整 §4.3A 校验。
 */
export function isPartTimeEndShortened(currentEnd: string | null, nextEnd: string | null): boolean {
  if (nextEnd === null) return false;
  return currentEnd === null || nextEnd < currentEnd;
}

/** 调动勾选结束兼职：失效日 = 调动实际生效日 − 1（#71、R2d、R2f 三次实测一致，AC-LNK-06）。 */
export function partTimeTransferEndDate(transferEffectiveDate: string): string {
  return addDays(transferEffectiveDate, -1);
}

/** 离职 / 退休落地：L′ = 实际生效日 − 1（迟到顺延后的 E′，S7）。 */
export function partTimeExitEndDate(exitEffectiveDate: string): string {
  return addDays(exitEffectiveDate, -1);
}

/**
 * 系统缩短（离职钩子 §4.6、调动端口 §4.7）：把区间截到 lastDay，返回要追加的结束日，null = 不追加（幂等，S4）。
 * 开始日晚于 lastDay 的写空区间（end = start − 1，S5 / S6 的 P3）；当前结束日已不晚于目标结束日的不动。
 */
export function partTimeCutoffEnd(span: PartTimeSpan, lastDay: string): string | null {
  const target = span.startDate > lastDay ? addDays(span.startDate, -1) : lastDay;
  return span.endDate !== null && span.endDate <= target ? null : target;
}
