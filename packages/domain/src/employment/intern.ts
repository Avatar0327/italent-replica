/** 实习生的纯规则（R2 BE-6a；docs/02_业务建模/31 §2，差距表 B34～B41，补证结论 R2f B41）。 */
import { termEnd } from '../contracts/rules.js';

/** 实习四视图：实习中 / 实习转正中 / 已转正 / 已离职（B34～B37）。 */
export const INTERN_VIEWS = ['interning', 'converting', 'converted', 'left'] as const;
export type InternView = (typeof INTERN_VIEWS)[number];

/** 直接实习转正表单的“试用期(月)”下拉选项（R2f B41：1～6）。 */
export const PROBATION_MONTH_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

/**
 * 预计试用结束日 = 开始 + 月数 − 1 天（R2f B41 实测 10-16 + 1 个月 = 11-15），与合同期限终止日同一口径（termEnd）。
 * BE-3 会加同义的共用函数；先合入的一方为准，后合入的一方改为调用同一个（03 协调 10-17）。
 */
export function probationExpectedEnd(startDate: string, months: number): string {
  return termEnd(startDate, months);
}
