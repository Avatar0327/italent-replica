/**
 * 编译器的对外诊断类型与规模常量（R3-T05 设计 §3.3）。错误与警告只带码、行号、偏移，
 * 不带文案、不带任何字段值：值可能是敏感数据，文案由各出口按码渲染（DEC-045、§3.4）。
 */
import type { RuleFieldRef } from './types.js';

/** 规模上限（§3.3 第 3 条）。发码后的字符 / 词 / 层数上限由 R3-T00 引擎自己的常量把关。 */
export const RULE_LIMITS = {
  maxRows: 50,
  maxValuesPerRow: 20,
  maxParenDepth: 20,
  /**
   * 组合表达式里行引用的次数上限。一次引用发码至少 3 词（括号 + `false`），引擎 800 词的上限决定了
   * 超过 200 次的表达式不可能编译成功，所以在解析阶段就拒绝，避免对超长输入做无谓的展开。
   */
  maxExpressionRefs: 200,
} as const;

export type RuleErrorCode =
  | 'RULE_EXPRESSION_SYNTAX'
  | 'RULE_ROW_UNKNOWN'
  | 'RULE_ROW_INVALID'
  | 'RULE_LITERAL_INVALID'
  | 'RULE_FIELD_NOT_ALLOWED'
  | 'RULE_TOO_LARGE';

/** `RULE_ROW_INVALID n` 的细分原因，便于前端定位到单元格；不是新的对外错误码。 */
export type RuleRowInvalidReason =
  | 'ROW_NO_INVALID'
  | 'FIELD_MISSING'
  | 'FIELD_UNKNOWN'
  | 'FIELD_MISMATCH'
  | 'FIELD_PATH_INVALID'
  | 'OPERATOR_INVALID'
  | 'VALUE_COUNT'
  | 'VALUE_TYPE'
  | 'OPTION_UNKNOWN'
  | 'ENGINE';

export interface RuleCompileError {
  readonly code: RuleErrorCode;
  /** 出错的条件行；整体错误（规模、组合表达式）没有。 */
  readonly rowNo?: number;
  readonly reason?: RuleRowInvalidReason;
  /** 组合表达式源文本里的字符偏移。 */
  readonly offset?: number;
}

export interface RuleWarning {
  /** 需要值的运算符而值列为空（DEC-305④）/ 条件行没被组合表达式引用（Q09 暂按警告）。 */
  readonly code: 'RULE_ROW_VALUE_MISSING' | 'RULE_ROW_UNREFERENCED';
  readonly rowNo: number;
}

/**
 * 字段目录：权威的字段定义由宿主（T04 字段描述、员工 / 任职 / 组织字段表）提供。
 * 条件行里带的 `field` 只是引用，类型、路径与选项域一律以目录为准，防止调用方伪造类型绕过校验。
 */
export interface RuleFieldCatalog {
  resolve(object: RuleFieldRef['object'], code: string): RuleFieldRef | undefined;
}

export interface CompileRuleSetOptions {
  /**
   * Q-SC-23：取证前多选字段不进条件行（DEC-314②），默认 false → `RULE_FIELD_NOT_ALLOWED`。
   * 取证结论为“不适用”后由宿主打开，改用 `"|v|"` 编码 + `Contains` 发码（§3.2）。
   */
  readonly allowMultiOption?: boolean;
}
