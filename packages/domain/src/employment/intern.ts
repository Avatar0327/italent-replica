/** 实习生的纯规则（R2 BE-6a；docs/02_业务建模/31 §2，差距表 B34～B41，补证结论 R2f B41）。 */

/** 实习四视图：实习中 / 实习转正中 / 已转正 / 已离职（B34～B37）。试用期月数与预计结束日沿用 BE-3（probation.ts）。 */
export const INTERN_VIEWS = ['interning', 'converting', 'converted', 'left'] as const;
export type InternView = (typeof INTERN_VIEWS)[number];
