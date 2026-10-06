/**
 * 计算失败的结构化结果（`26` §8.4）：原因码机器可读，文案对齐原站用语；引擎不抛未捕获异常。
 */

export const FAILURE_CODES = [
  'SYNTAX_ERROR',
  'UNKNOWN_FUNCTION',
  'ARGUMENT_COUNT',
  'ARGUMENT_TYPE',
  'UNKNOWN_FIELD',
  'FIELD_FORBIDDEN',
  'DATA_FORBIDDEN',
  'DATA_UNAVAILABLE',
  'EMPTY_IN_COMPARISON',
  'EMPTY_IN_ARITHMETIC',
  'EMPTY_IN_AGGREGATE',
  'TEXT_IN_ARITHMETIC',
  'TYPE_CONVERSION',
  'DIVISION_BY_ZERO',
  'OUT_OF_SCOPE',
  'CYCLIC_DEPENDENCY',
  'DEPENDENCY_FAILED',
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
