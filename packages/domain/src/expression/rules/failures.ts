/**
 * 求值失败 → “第 n 行条件出错”（R3-T05 设计 §3.4）。
 * 引擎 `message` 可能带字段值（`operators.ts` 的比较失败文案），所以这里只用错误码和位置，
 * 一律按固定映射渲染；列表、详情、失败明细、两种重放、通知、审计共用这一个出口。
 */
import type { ComputationFailure, FailureCode } from '../failures.js';
import type { CompiledRuleSet } from './types.js';

export interface RuleFailureReport {
  readonly code: FailureCode;
  /** 定位到的条件行；落在组合层或没有位置时缺省。 */
  readonly rowNo?: number;
  /** 固定文案，不含任何字段值。 */
  readonly text: string;
}

const REASONS: Readonly<Partial<Record<FailureCode, string>>> = {
  TYPE_CONVERSION: '比较或转换时类型不符',
  ARGUMENT_TYPE: '比较或转换时类型不符',
  EMPTY_IN_COMPARISON: '空值参与运算',
  EMPTY_IN_ARITHMETIC: '空值参与运算',
  DIVISION_BY_ZERO: '除以 0',
  FIELD_FORBIDDEN: '计算主体无权读取字段',
  DATA_UNAVAILABLE: '数据源不可用',
  UNKNOWN_FIELD: '规则需要重新编译',
  UNKNOWN_FUNCTION: '规则需要重新编译',
  SYNTAX_ERROR: '规则需要重新编译',
};

const FALLBACK_TEXT = '条件表达式出错';

/** offset 落在哪个行引用区间（左闭右开）就是哪一行；同一行多处引用都能命中。 */
export function locateRuleRow(rowSpans: CompiledRuleSet['rowSpans'], offset: number | undefined): number | undefined {
  if (offset === undefined) return undefined;
  return rowSpans.find((span) => offset >= span.start && offset < span.end)?.rowNo;
}

export function describeRuleFailure(
  failure: ComputationFailure,
  rowSpans: CompiledRuleSet['rowSpans'],
): RuleFailureReport {
  const rowNo = locateRuleRow(rowSpans, failure.offset);
  const reason = REASONS[failure.code];
  if (rowNo === undefined || reason === undefined) return { code: failure.code, text: FALLBACK_TEXT };
  return { code: failure.code, rowNo, text: `第 ${rowNo} 行条件出错：${reason}` };
}
