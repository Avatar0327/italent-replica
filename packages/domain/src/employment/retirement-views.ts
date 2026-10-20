/**
 * 退休五视图的纯口径（docs/08_设计/R2-T04_退休设计.md §10；DEC-638 A-7）。
 * SQL 一侧（apps/api employment/retirement-views.ts）与这里各自实现同一张谓词表，验收用固定夹具逐边界断言，再用随机夹具对照。
 * 日期是租户业务日（YYYY-MM-DD），比较即字典序；“已提交 / 已存在”由调用方按 asOf 当日结束（租户时区）折算成布尔。
 */
import { addDays } from '../contracts/rules.js';

export const RETIREMENT_VIEWS = ['upcoming', 'overdue', 'processing', 'completed', 'all'] as const;
export type RetirementView = (typeof RETIREMENT_VIEWS)[number];
export type RetirementPersonView = Extract<RetirementView, 'upcoming' | 'overdue'>;
export type RetirementBillView = Exclude<RetirementView, RetirementPersonView>;

/** 即将退休天数 N 的取值范围（租户配置 retirement.upcoming_days 与请求参数同一范围）。 */
export const RETIREMENT_UPCOMING_DAYS = { min: 1, max: 365 } as const;

export interface RetirementPersonFacts {
  /** asOf 当天有主职任职记录，且不是离职 / 退休记录、不是待入职。 */
  readonly active: boolean;
  /** 当前周期 S（asOf 当天记录的 staff_id）；不在职为 null。 */
  readonly staffId: string | null;
  readonly cycleEntryDate: string | null;
  /** 人事 P：asOf 当日结束之前的最新人事版本。 */
  readonly expectedDate: string | null;
}

export interface RetirementBillFacts {
  readonly id: string;
  /** 退休单所属周期（exit_requests.staff_id）。 */
  readonly staffId: string;
  /** 查询时的当前最新状态（§10.1：被撤销的单是 voided / deleted）。 */
  readonly state: string;
  /** 首个 in_review / approved 状态事件落在 asOf 当日结束之前。 */
  readonly submitted: boolean;
  /** 业务创建时间落在 asOf 当日结束之前。 */
  readonly existed: boolean;
  /** 当前最新载荷的 E′（顺延后）。 */
  readonly effectiveDate: string;
}

export interface RetirementClassifyInput {
  readonly asOf: string;
  readonly upcomingDays: number;
  readonly person: RetirementPersonFacts;
  readonly bills: readonly RetirementBillFacts[];
}

/** “流程中”：当前状态审批中 / 已批准，且 asOf 时已提交（草稿、驳回不是）。 */
export const isRetirementInProcess = (bill: Pick<RetirementBillFacts, 'state' | 'submitted'>): boolean =>
  bill.submitted && (bill.state === 'in_review' || bill.state === 'approved');

/** 员工行：即将退休 / 过期未退休（§10.2 前两行；周期限定只看当前周期 S 的退休单）。 */
function personView(input: RetirementClassifyInput): RetirementPersonView | null {
  const { person, asOf, bills } = input;
  const expected = person.expectedDate;
  if (!person.active || !expected || !person.cycleEntryDate || expected < person.cycleEntryDate) return null;
  const blocked = bills.some(
    (bill) => bill.staffId === person.staffId && (isRetirementInProcess(bill) || bill.state === 'effective'),
  );
  if (blocked) return null;
  if (expected < asOf) return 'overdue';
  return expected <= addDays(asOf, input.upcomingDays) ? 'upcoming' : null;
}

/** 单据行：退休中 / 已完成 / 全部（草稿、驳回只进“全部”；asOf 前尚不存在的单不进任何视图）。 */
function billViews(asOf: string, bill: RetirementBillFacts): RetirementBillView[] {
  const views: RetirementBillView[] = [];
  const effective = bill.state === 'effective';
  if (isRetirementInProcess(bill) || (effective && bill.effectiveDate > asOf && bill.submitted))
    views.push('processing');
  if (effective && bill.effectiveDate <= asOf) views.push('completed');
  if (bill.existed) views.push('all');
  return views;
}

export function classifyRetirement(input: RetirementClassifyInput): {
  readonly person: RetirementPersonView | null;
  readonly bills: readonly { readonly id: string; readonly views: readonly RetirementBillView[] }[];
} {
  return {
    person: personView(input),
    bills: input.bills.map((bill) => ({ id: bill.id, views: billViews(input.asOf, bill) })),
  };
}
