/**
 * 单条条件行的校验与发码（R3-T05 设计 §3.2 发码表）。
 * 守卫统一写成 `not IsEmpty(F) and …`：引擎 `and` 为短路，空值不会走到比较里触发 TYPE_CONVERSION /
 * EMPTY_IN_COMPARISON，也不会让 `!= 0`、`= 空` 误命中（R3-06）。
 */
import type { StaticKind } from '../values.js';
import {
  RULE_LIMITS,
  type CompileRuleSetOptions,
  type RuleCompileError,
  type RuleFieldCatalog,
  type RuleRowInvalidReason,
} from './diagnostics.js';
import { literalFor, type LiteralFailure } from './literals.js';
import {
  RULE_OPERATORS,
  type RuleConditionRow,
  type RuleFieldKind,
  type RuleFieldRef,
  type RuleOperator,
} from './types.js';

export interface RowCode {
  /** 发码文本；`parenthesized` 为 true 时它已自带最外层括号，引用处不再加。 */
  readonly text: string;
  readonly parenthesized: boolean;
  /** 公式里用到的字段完整路径；aggregate 行为 `行n.值`。 */
  readonly path: string;
  /** 交给引擎 `fieldKind` 的静态类型（option / multi_option 降映射为 text，§3.1）。 */
  readonly engineKind: StaticKind;
  readonly valueMissing: boolean;
}

export type RowCodeResult =
  { readonly ok: true; readonly code: RowCode } | { readonly ok: false; readonly error: RuleCompileError };

const MEMBER_NAME = '[A-Za-z0-9_\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';
/** 引擎词法能原样识别的 `对象.字段`（成员位置允许连字符，DEC-228）；挡住目录里混入运算符、引号、空白。 */
const FIELD_PATH = new RegExp(`^${MEMBER_NAME}+\\.(?:${MEMBER_NAME}|-)+$`);

const ALL_OPERATORS: ReadonlySet<RuleOperator> = new Set(RULE_OPERATORS);
const EQUALITY_OPERATORS: ReadonlySet<RuleOperator> = new Set(['is_empty', 'not_empty', 'eq', 'ne']);
const ORDERED_KINDS: ReadonlySet<RuleFieldKind> = new Set(['number', 'date']);
const SINGLE_VALUE_OPERATORS: ReadonlySet<RuleOperator> = new Set(['gt', 'lt', 'ge', 'le']);
const COMPARATORS: Readonly<Record<'gt' | 'lt' | 'ge' | 'le', string>> = { gt: '>', lt: '<', ge: '>=', le: '<=' };

const invalid = (rowNo: number, reason: RuleRowInvalidReason): RowCodeResult => ({
  ok: false,
  error: { code: 'RULE_ROW_INVALID', rowNo, reason },
});

const engineKindOf = (kind: RuleFieldKind): StaticKind =>
  kind === 'option' || kind === 'multi_option' ? 'text' : kind;

type Resolved =
  | { readonly ok: true; readonly path: string; readonly kind: RuleFieldKind; readonly field?: RuleFieldRef }
  | { readonly ok: false; readonly result: RowCodeResult };

/** aggregate 行：宿主先算度量，以 `行n.值`（number）注入；field 行：字段定义以目录为准。 */
function resolveField(row: RuleConditionRow, catalog: RuleFieldCatalog, options: CompileRuleSetOptions): Resolved {
  if (row.kind === 'aggregate') return { ok: true, path: `行${row.rowNo}.值`, kind: 'number' };
  const declared = row.field;
  if (!declared) return { ok: false, result: invalid(row.rowNo, 'FIELD_MISSING') };
  const field = catalog.resolve(declared.object, declared.code);
  if (!field) return { ok: false, result: invalid(row.rowNo, 'FIELD_UNKNOWN') };
  if (field.path !== declared.path || field.kind !== declared.kind) {
    return { ok: false, result: invalid(row.rowNo, 'FIELD_MISMATCH') };
  }
  if (field.kind === 'multi_option' && !options.allowMultiOption) {
    return { ok: false, result: { ok: false, error: { code: 'RULE_FIELD_NOT_ALLOWED', rowNo: row.rowNo } } };
  }
  if (!FIELD_PATH.test(field.path)) return { ok: false, result: invalid(row.rowNo, 'FIELD_PATH_INVALID') };
  return { ok: true, path: field.path, kind: field.kind, field };
}

function operatorAllowed(operator: RuleOperator, kind: RuleFieldKind): boolean {
  if (!ALL_OPERATORS.has(operator)) return false;
  return ORDERED_KINDS.has(kind) || EQUALITY_OPERATORS.has(operator);
}

/** 需要值的运算符，值个数：eq / ne 至少 1 个，gt / lt / ge / le 恰 1 个，between 恰 2 个。 */
function valueCountMatches(operator: RuleOperator, count: number): boolean {
  if (operator === 'between') return count === 2;
  return SINGLE_VALUE_OPERATORS.has(operator) ? count === 1 : count >= 1;
}

function literalError(rowNo: number, failure: LiteralFailure): RowCodeResult {
  if (failure === 'LITERAL_INVALID') return { ok: false, error: { code: 'RULE_LITERAL_INVALID', rowNo } };
  return invalid(rowNo, failure);
}

const guarded = (path: string, body: string): { text: string; parenthesized: true } => ({
  text: `(not IsEmpty(${path}) and ${body})`,
  parenthesized: true,
});

function emitValueRow(row: RuleConditionRow, path: string, kind: RuleFieldKind, literals: readonly string[]) {
  const operator = row.operator;
  const [first = ''] = literals;
  if (kind === 'multi_option') {
    const anyOf = literals.map((literal) => `Contains(${path}, ${literal})`).join(' or ');
    if (operator === 'ne') return guarded(path, `not (${anyOf})`);
    return guarded(path, literals.length > 1 ? `(${anyOf})` : anyOf);
  }
  switch (operator) {
    case 'eq':
      return guarded(path, literals.length > 1 ? `IN(${path}, ${literals.join(', ')})` : `${path} = ${first}`);
    case 'ne':
      return guarded(path, literals.length > 1 ? `NOTIN(${path}, ${literals.join(', ')})` : `${path} != ${first}`);
    case 'between':
      return guarded(path, `${path} >= ${literals[0]} and ${path} <= ${literals[1]}`);
    default:
      return guarded(path, `${path} ${COMPARATORS[operator as keyof typeof COMPARATORS]} ${first}`);
  }
}

export function buildRowCode(
  row: RuleConditionRow,
  catalog: RuleFieldCatalog,
  options: CompileRuleSetOptions,
): RowCodeResult {
  const resolved = resolveField(row, catalog, options);
  if (!resolved.ok) return resolved.result;
  const { path, kind } = resolved;
  const engineKind = engineKindOf(kind);
  const done = (text: string, parenthesized: boolean, valueMissing = false): RowCodeResult => ({
    ok: true,
    code: { text, parenthesized, path, engineKind, valueMissing },
  });

  // 候选值上限对所有运算符一视同仁（is_empty / not_empty 的多余值虽被忽略，也不应无限长）
  const values = row.values ?? [];
  if (values.length > RULE_LIMITS.maxValuesPerRow) {
    return { ok: false, error: { code: 'RULE_TOO_LARGE', rowNo: row.rowNo } };
  }
  if (!operatorAllowed(row.operator, kind)) return invalid(row.rowNo, 'OPERATOR_INVALID');
  if (row.operator === 'is_empty') return done(`IsEmpty(${path})`, false);
  if (row.operator === 'not_empty') return done(`not IsEmpty(${path})`, false);

  // 值列为空：整行按“不满足”，保存时给警告而不是拦截（DEC-305④）
  if (values.length === 0) return done('false', false, true);
  if (!valueCountMatches(row.operator, values.length)) return invalid(row.rowNo, 'VALUE_COUNT');

  const literals: string[] = [];
  for (const value of values) {
    const literal = literalFor(kind, value, resolved.field);
    if (!literal.ok) return literalError(row.rowNo, literal.failure);
    literals.push(literal.text);
  }
  const emitted = emitValueRow(row, path, kind, literals);
  return done(emitted.text, emitted.parenthesized);
}
