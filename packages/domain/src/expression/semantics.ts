/**
 * 空值与类型转换的语义配置（`26` §8.2 / §8.3）。
 *
 * 默认值依据 DEC-257（取证 Q-M0-95 原站试算，`26` §8.5）照原站：空 + 1 = 1、ToNumber(空) = 0、
 * Average(空, 4) 计算失败、"5" + 1 = 6、空 > 3 为假。文本比较大小一律失败写在 operators.ts 的 compare。
 * 函数参数与聚合的口径依据 DEC-270（取证 Q-M0-105，`26` §8.8）：Round(空) / Abs(空) 失败、空日期按 0001-01-01、
 * Sum(1, "5") = "15"。
 */

export interface ExpressionSemantics {
  /** ToNumber(空)：原站实测为 0（`26` §8.5）。 */
  readonly toNumberOfEmpty: 'zero' | 'empty' | 'fail';
  /** 空值参与加减乘除：原站实测按 0，空 + 1 = 1（`26` §8.5）。不含函数参数（见 emptyInFunctionArgument）。 */
  readonly emptyInArithmetic: 'fail' | 'empty' | 'zero';
  /** 函数的数值参数为空（Round(空)、Abs(空)……）：原站实测计算失败（`26` §8.8，DEC-270 取代 DEC-264 的按 0）。 */
  readonly emptyInFunctionArgument: 'fail' | 'zero';
  /** 日期函数的日期参数为空：原站按 0001-01-01 参与运算，Year(AddDays(空, 1)) = 1（`26` §8.8，DEC-270）。 */
  readonly emptyDateArgument: 'min-date' | 'fail';
  /** Sum 遇文本：原站按字符串拼接，Sum(1, "5") = "15"（`26` §8.8，DEC-270，与四则 "5" + 1 = 6 不同）。 */
  readonly textInSum: 'concatenate' | 'coerce';
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
  emptyInFunctionArgument: 'fail',
  emptyDateArgument: 'min-date',
  textInSum: 'concatenate',
  emptyInOrdering: 'false',
  emptyInEquality: 'compare',
  emptyInAggregate: 'fail',
  textInArithmetic: 'coerce',
  textNumberEquality: 'loose',
  emptyCondition: 'false',
  percentAsDecimal: true,
} as const);
