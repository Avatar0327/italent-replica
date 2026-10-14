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
  if (offset === undefined || offset < 0) return undefined;
  return rowSpans.find((span) => offset >= span.start && offset < span.end)?.rowNo;
}

/**
 * 失败位置的字符偏移：优先 offset；引擎有时只给行列。生成的公式恒为单行（值里的换行已被拒绝），
 * 所以第 1 行的第 n 列就是偏移 n - 1；多行位置不猜。
 */
function offsetOf(failure: ComputationFailure): number | undefined {
  if (failure.offset !== undefined) return failure.offset;
  return failure.line === 1 && failure.column !== undefined ? failure.column - 1 : undefined;
}

/**
 * 按错误码和行号渲染固定文案。列表、详情、失败明细、通知、审计只存 `code` + `rowNo`，
 * 展示时统一走这里重新渲染，不存文案、不用引擎 message（§3.4）。
 */
export function renderRuleFailureText(code: FailureCode, rowNo?: number): string {
  const reason = REASONS[code];
  return rowNo === undefined || reason === undefined ? FALLBACK_TEXT : `第 ${rowNo} 行条件出错：${reason}`;
}

export function describeRuleFailure(
  failure: ComputationFailure,
  rowSpans: CompiledRuleSet['rowSpans'],
): RuleFailureReport {
  const rowNo = locateRuleRow(rowSpans, offsetOf(failure));
  const text = renderRuleFailureText(failure.code, rowNo);
  // 没有对应固定文案的错误码即使定位到行也不带行号，与文案保持一致
  return rowNo === undefined || REASONS[failure.code] === undefined
    ? { code: failure.code, text }
    : { code: failure.code, rowNo, text };
}
