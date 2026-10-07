/**
 * 空值与类型转换的语义配置（`26` §8.2 / §8.3，手册口径 🟡）。
 *
 * ⚠️ 待 Q-M0-95 原站试算核对：空值参与四则的结果、ToNumber(空) 是否为 0、Average 是否跳过空、
 * 字符串与数字比较的结果。结论回来后只改本文件的 DEFAULT_SEMANTICS，不改求值器。
 */

export interface ExpressionSemantics {
  /** ToNumber(空)：手册推定为 0（`26` §8.2）。 */
  readonly toNumberOfEmpty: 'zero' | 'empty' | 'fail';
  /** 空值参与加减乘除：取数函数取不到返回空、不自动当 0，参与计算按失败处理（`26` §8.2）。 */
  readonly emptyInArithmetic: 'fail' | 'empty' | 'zero';
  /** 空值参与大于 / 小于比较：计算失败（207126957 问题 1）。 */
  readonly emptyInOrdering: 'fail' | 'false';
  /** 空值参与 = / ≠：按值比较（空 = 空 为真），不视为失败。 */
  readonly emptyInEquality: 'compare' | 'fail';
  /** 空值参与 Average / Sum / Max / Min：计算失败（210929396 §4）。 */
  readonly emptyInAggregate: 'fail' | 'skip';
  /** 字符串参与四则：无结果（`26` §8.3）。 */
  readonly textInArithmetic: 'fail' | 'coerce';
  /** 文本与数字比较相等：本租户年度既有 "2026" 也有 2026 的写法，按数值宽松比较。 */
  readonly textNumberEquality: 'loose' | 'strict';
  /** 如果 的条件为空：按“否”判断（171640267）。 */
  readonly emptyCondition: 'false' | 'fail';
  /** 百分比按小数取值（82% → 0.82）。 */
  readonly percentAsDecimal: boolean;
}

export const DEFAULT_SEMANTICS: ExpressionSemantics = Object.freeze({
  toNumberOfEmpty: 'zero',
  emptyInArithmetic: 'fail',
  emptyInOrdering: 'fail',
  emptyInEquality: 'compare',
  emptyInAggregate: 'fail',
  textInArithmetic: 'fail',
  textNumberEquality: 'loose',
  emptyCondition: 'false',
  percentAsDecimal: true,
} as const);
