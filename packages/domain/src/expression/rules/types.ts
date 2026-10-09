/**
 * 结构化条件行的公共契约（R3-T05 设计 §3.1；DEC-261）：风险等级、健康度、人员范围与 R3-T06 入池规则（Q-M0-114
 * `PoolRule`）共用。条件行是唯一原始数据，编译出的表达式只是派生缓存；编译器与求值宿主随 R3-T05 PR-B 在本目录实现，
 * 这里只定类型，供 T05 / T06 两边先对齐。名称带 Rule 前缀，避免与人员字段的 FieldKind 等同名导出冲突。
 */

/** 条件行字段的值类型；宿主注入值与引擎 StaticKind 的对应见设计 §3.1。 */
export type RuleFieldKind = 'text' | 'number' | 'option' | 'multi_option' | 'date' | 'boolean';

export interface RuleFieldRef {
  readonly object: 'employee' | 'employment' | 'successor' | 'review_object' | 'org';
  readonly code: string;
  readonly path: string;
  readonly kind: RuleFieldKind;
  /** 选项域以 T04 ReviewFieldDescriptor 为准（同步协议 SP-17），value 一律字符串。 */
  readonly optionDomain?: readonly { readonly value: string; readonly label: string; readonly enabled: boolean }[];
}

export const RULE_OPERATORS = ['is_empty', 'not_empty', 'eq', 'ne', 'gt', 'lt', 'ge', 'le', 'between'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** aggregate = 宿主先算度量值再以“行n.值”注入（风险 / 健康度）；field = 直接对对象字段比较（人群、入池）。 */
export interface RuleConditionRow {
  readonly rowNo: number;
  readonly kind: 'aggregate' | 'field';
  readonly field?: RuleFieldRef;
  readonly operator: RuleOperator;
  readonly values?: readonly (number | string | boolean)[];
}

/** 条件行 + 按行号组合的表达式（只认 and / or / 括号 / 正整数，§3.3）。 */
export interface RuleSet {
  readonly rows: readonly RuleConditionRow[];
  readonly expression: string;
}

/** 编译结果：rowSpans 把引擎失败位置映射回“第 n 行条件出错”（§3.4），不向外暴露内部表达式。 */
export interface CompiledRuleSet {
  readonly formula: string;
  readonly rowSpans: readonly { readonly rowNo: number; readonly start: number; readonly end: number }[];
  readonly referencedRows: readonly number[];
  readonly unreferencedRows: readonly number[];
  readonly constantFalseRows: readonly number[];
  readonly compilerVersion: string;
}
