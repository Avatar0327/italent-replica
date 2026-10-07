/**
 * 空值与类型转换的语义配置（`26` §8.2 / §8.3）。
 *
 * 默认值依据 DEC-257（取证 Q-M0-95 原站试算，`26` §8.5）照原站：空 + 1 = 1、ToNumber(空) = 0、
 * Average(空, 4) 计算失败、"5" + 1 = 6、空 > 3 为假。文本比较大小一律失败写在 operators.ts 的 compare。
 */

export interface ExpressionSemantics {
  /** ToNumber(空)：原站实测为 0（`26` §8.5）。 */
  readonly toNumberOfEmpty: 'zero' | 'empty' | 'fail';
  /** 空值参与加减乘除（含函数的数值参数）：原站实测按 0，空 + 1 = 1（`26` §8.5）。 */
  readonly emptyInArithmetic: 'fail' | 'empty' | 'zero';
  /** 空值参与大于 / 小于比较：原站实测结果为假、不报错，与手册 207126957 不符（`26` §8.5）。 */
  readonly emptyInOrdering: 'fail' | 'false';
  /** 空值参与 = / ≠：按值比较（空 = 空 为真），不视为失败。 */
  readonly emptyInEquality: 'compare' | 'fail';
  /** 空值参与 Average / Sum / Max / Min：计算失败，不跳过空值（`26` §8.5 实测 Average(空, 4)）。 */
  readonly emptyInAggregate: 'fail' | 'skip';
  /** 字符串参与四则：数字字符串按数值（"5" + 1 = 6），非数字文本仍失败（`26` §8.5 修正 §8.3）。 */
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
  emptyInArithmetic: 'zero',
  emptyInOrdering: 'false',
  emptyInEquality: 'compare',
  emptyInAggregate: 'fail',
  textInArithmetic: 'coerce',
  textNumberEquality: 'loose',
  emptyCondition: 'false',
  percentAsDecimal: true,
} as const);
