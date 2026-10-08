/**
 * 计算失败的结构化结果（`26` §8.4）：原因码机器可读，文案对齐原站用语；引擎不抛未捕获异常。
 */

export const FAILURE_CODES = [
  'SYNTAX_ERROR',
  /** 字符串用了中文引号（`26` §8.3）；三条入口同一失败码。 */
  'CHINESE_QUOTE',
  'UNKNOWN_FUNCTION',
  'ARGUMENT_COUNT',
  'ARGUMENT_TYPE',
  'UNKNOWN_FIELD',
  'FIELD_FORBIDDEN',
  'DATA_FORBIDDEN',
  'DATA_UNAVAILABLE',
  /** 须取到唯一值的取数（人事子集）取到多条。 */
  'AMBIGUOUS_DATA',
  /** 面板上有、口径待取证的函数（有效时长）：已注册可保存，求值时失败。 */
  'FUNCTION_UNAVAILABLE',
  'EMPTY_IN_COMPARISON',
  'EMPTY_IN_ARITHMETIC',
  'EMPTY_IN_AGGREGATE',
  'TEXT_IN_ARITHMETIC',
  'TYPE_CONVERSION',
  /** 目标字段适配器的结构化失败（F-049 / R3-T04 C-07）；失败不进入 computed。 */
  'OUTPUT_TYPE_MISMATCH',
  'OUTPUT_OPTION_INVALID',
  'OUTPUT_OVERFLOW',
  'DIVISION_BY_ZERO',
  'OUT_OF_SCOPE',
  'CYCLIC_DEPENDENCY',
  'DEPENDENCY_FAILED',
  /** 计算上下文本身不合法（时区、今天）。 */
  'CONTEXT_INVALID',
  /** 公共边界兜底：未预期的异常，不透出内容。 */
  'INTERNAL_ERROR',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export interface SourcePosition {
  /** 从 1 起算。 */
  readonly line: number;
  /** 从 1 起算，按字符计。 */
  readonly column: number;
  readonly offset: number;
}

export interface ComputationFailure extends Partial<SourcePosition> {
  readonly code: FailureCode;
  /** 原文风格的失败文案（`26` §8.4），不包含被隐藏字段的取数结果。 */
  readonly message: string;
}

/** 原站文案（`26` §8.4）：通用前缀 + 具体原因。 */
export const FAILURE_PREFIX = '计算失败';
export const CONVERSION_MESSAGE = '公式无法计算，提示转换出错';
export const PARSER_MESSAGE = '公式解析器异常，使用了无效的公式文本。';

/** DEC-228：字段名内的连字符一律属于字段名，两个字段相减须在减号两侧加空格。 */
export const HYPHEN_SUBTRACTION_HINT = '（字段名含“-”；如需相减，请在减号两侧加空格）';

export function hyphenHint(path: string): string {
  return path.includes('-') ? HYPHEN_SUBTRACTION_HINT : '';
}

/** 求值过程内部用异常传递失败，在 evaluateFormula 边界统一转成结构化结果。 */
export class ComputationError extends Error {
  readonly failure: ComputationFailure;

  constructor(failure: ComputationFailure) {
    super(failure.message);
    this.name = 'ComputationError';
    this.failure = failure;
  }
}

export function fail(code: FailureCode, detail: string, position?: SourcePosition): never {
  const message = `${FAILURE_PREFIX}：${detail}`;
  throw new ComputationError(position ? { code, message, ...position } : { code, message });
}
