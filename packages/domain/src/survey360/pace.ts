/**
 * 评价过快的纯规则（F-060 收尾，DEC-392）：平均单题耗时 < 1.5 秒算过快（疑似无效 / 作答端提醒）。
 * 耗时的起算（该评价对象答卷首次打开 → 提交 / 本页上次翻页 → 点“下一页”）与分母（全部可答题 / 本页题数）由调用方
 * 给出；这里只做比较，不碰时钟与数据库。
 */

/** 每题 1.5 秒；严格小于才算过快，恰好 1.5 秒 / 题不算。 */
export const FAST_ANSWER_MS_PER_ITEM = 1500;

/** durationMs：总耗时（毫秒，负数按 0 处理）；itemCount：题目数，没有题目不判。 */
export function isTooFast(durationMs: number, itemCount: number): boolean {
  if (itemCount <= 0) return false;
  return Math.max(0, durationMs) / itemCount < FAST_ANSWER_MS_PER_ITEM;
}
