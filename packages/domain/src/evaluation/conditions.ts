/**
 * 参评条件的纯校验（EV-R10 / EV-R11，R3-T02 设计 §3.2、§10 表达式行；拆分方案 B2）：
 * - 明细 9 种运算符 🟢（规格 24 Q-M0-108 实测）的取值形状；
 * - 组合表达式用 R3-T00 的 validateFormula 校验语法，且只能引用存在的条件序号（字段名 条件1…条件n）。
 * 不按人员求值：C2 先逐条算真假，再以条件序号作布尔字段交 evaluateFormula。运算符编码与 T05 条件行（RULE_OPERATORS）一致。
 */
import { createDefaultRegistry, validateFormula } from '../expression/index.js';

export const ACTIVITY_CONDITION_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'lt',
  'ge',
  'le',
  'is_empty',
  'not_empty',
  'between',
] as const;
export type ActivityConditionOperator = (typeof ACTIVITY_CONDITION_OPERATORS)[number];

export interface ActivityConditionDetailInput {
  readonly seq: number;
  readonly operator: string;
  readonly value1?: string | number | null;
  readonly value2?: string | number | null;
}

export type ActivityConditionDetailIssueCode =
  'SEQ_INVALID' | 'SEQ_DUPLICATE' | 'OPERATOR_INVALID' | 'VALUE_REQUIRED' | 'VALUE_NOT_ALLOWED' | 'RANGE_INVERTED';

export interface ActivityConditionDetailIssue {
  readonly seq: number;
  readonly code: ActivityConditionDetailIssueCode;
}

export type ActivityConditionDetailsResult =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly ActivityConditionDetailIssue[] };

const hasValue = (value: string | number | null | undefined): boolean =>
  value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');

const COMPARISONS: readonly string[] = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];

/** 单条明细的取值形状；运算符不认识时只报运算符。 */
function valueIssue(detail: ActivityConditionDetailInput): ActivityConditionDetailIssueCode | undefined {
  const { operator, value1, value2 } = detail;
  if (COMPARISONS.includes(operator)) {
    if (!hasValue(value1)) return 'VALUE_REQUIRED';
    return hasValue(value2) ? 'VALUE_NOT_ALLOWED' : undefined;
  }
  if (operator === 'between') {
    if (!hasValue(value1) || !hasValue(value2)) return 'VALUE_REQUIRED';
    return typeof value1 === 'number' && typeof value2 === 'number' && value1 > value2 ? 'RANGE_INVERTED' : undefined;
  }
  return hasValue(value1) || hasValue(value2) ? 'VALUE_NOT_ALLOWED' : undefined; // is_empty / not_empty
}

export function validateActivityConditionDetails(
  details: readonly ActivityConditionDetailInput[],
): ActivityConditionDetailsResult {
  const issues: ActivityConditionDetailIssue[] = [];
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const detail of details) {
    if (!Number.isInteger(detail.seq) || detail.seq < 1) {
      issues.push({ seq: detail.seq, code: 'SEQ_INVALID' });
      continue;
    }
    if (seen.has(detail.seq)) {
      if (!duplicated.has(detail.seq)) issues.push({ seq: detail.seq, code: 'SEQ_DUPLICATE' });
      duplicated.add(detail.seq);
      continue;
    }
    seen.add(detail.seq);
    if (!(ACTIVITY_CONDITION_OPERATORS as readonly string[]).includes(detail.operator)) {
      issues.push({ seq: detail.seq, code: 'OPERATOR_INVALID' });
      continue;
    }
    const code = valueIssue(detail);
    if (code) issues.push({ seq: detail.seq, code });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

const FIELD_PREFIX = '条件';
export const activityConditionField = (seq: number): string => `${FIELD_PREFIX}${seq}`;

export interface ActivityConditionExpressionError {
  readonly code: 'EXPRESSION_EMPTY' | 'EXPRESSION_SYNTAX' | 'CONDITION_SEQ_UNKNOWN' | 'EXPRESSION_FUNCTION_NOT_ALLOWED';
  readonly message?: string;
  readonly line?: number;
  readonly column?: number;
  readonly offset?: number;
}

export type ActivityConditionExpressionResult =
  | { readonly ok: true; readonly referencedSeqs: readonly number[] }
  | { readonly ok: false; readonly errors: readonly ActivityConditionExpressionError[] };

const CONDITION_KIND = 'boolean' as const;
const registry = createDefaultRegistry();

/**
 * 组合式允许的函数白名单（设计 §6.1：明细负责取数，组合式只组合已计算的条件）。只放只读入参、不访问端口与运行环境的
 * 纯函数：逻辑（AND / OR / IF / IN / NOTIN）、类型转换（ToNumber / ToText）、取余（Mod）。比较、算术、and / or / not
 * 是运算符，不经函数。按规范名比较（引擎收集的是解析别名后的规范名，中文别名同样覆盖）；Def 绑定里的调用一并收集。
 * 不用 recordObjects 判定：它只表示参数里的记录字段作用域，不是“访问外部数据”的标记（第 3 轮 P2-R2-01）。
 */
const COMBINATION_FUNCTIONS: ReadonlySet<string> = new Set([
  'AND',
  'OR',
  'IF',
  'IN',
  'NOTIN',
  'ToNumber',
  'ToText',
  'Mod',
]);
const notAllowed = (name: string): boolean => !COMBINATION_FUNCTIONS.has(registry.resolve(name)?.name ?? name);

/**
 * 空白表达式不通过：是否允许不设表达式由调用方决定（不设则不调用）。
 * 引擎对取数函数参数里的记录字段（考核结果.年度 等）不查字段目录，所以 validateFormula 通过后还要复核：
 * 引用到的每个字段都必须是已有的条件序号，且只能调用白名单内的纯组合函数；条件序号按布尔字段参与类型检查。
 */
export function validateActivityConditionExpression(
  expression: string,
  seqs: readonly number[],
): ActivityConditionExpressionResult {
  if (expression.trim() === '') return { ok: false, errors: [{ code: 'EXPRESSION_EMPTY' }] };
  const known = new Map(seqs.map((seq) => [activityConditionField(seq), seq]));
  const result = validateFormula(expression, {
    registry,
    isKnownField: (path) => known.has(path),
    fieldKind: (path) => (known.has(path) ? CONDITION_KIND : undefined),
  });
  if (!result.ok) {
    const errors = result.errors.map((issue) => ({
      code: issue.code === 'UNKNOWN_FIELD' ? ('CONDITION_SEQ_UNKNOWN' as const) : ('EXPRESSION_SYNTAX' as const),
      message: issue.message,
      line: issue.line,
      column: issue.column,
      offset: issue.offset,
    }));
    return { ok: false, errors };
  }
  const errors: ActivityConditionExpressionError[] = [
    ...result.fields.filter((field) => !known.has(field)).map(() => ({ code: 'CONDITION_SEQ_UNKNOWN' as const })),
    ...result.functions.filter(notAllowed).map(() => ({ code: 'EXPRESSION_FUNCTION_NOT_ALLOWED' as const })),
  ];
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, referencedSeqs: result.fields.map((field) => known.get(field)!) };
}
