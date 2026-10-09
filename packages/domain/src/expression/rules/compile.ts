/**
 * 条件行编译器（R3-T05 设计 §3，DEC-261）：条件行是唯一原始数据，这里把它编译成 R3-T00 引擎的公式缓存。
 * 纯函数、无 I/O；风险 / 健康度 / 人员范围（T05）与入池规则（T06）共用，宿主各自负责取数与求值。
 * 编译缓存是派生物，不得反写条件行（DEC-261）；引擎语义变化后用平台命令重新编译（#19）。
 */
import { validateFormula } from '../engine.js';
import { tokenize } from '../lexer.js';
import { MAX_FORMULA_LENGTH, MAX_FORMULA_TOKENS } from '../parser.js';
import type { ExpressionFieldKind } from '../values.js';
import {
  RULE_LIMITS,
  type CompileRuleSetOptions,
  type RuleCompileError,
  type RuleFieldCatalog,
  type RuleWarning,
} from './diagnostics.js';
import { locateRuleRow } from './failures.js';
import { buildRowCode, type RowCode } from './row-code.js';
import { parseRowExpression, type RowExpressionNode } from './row-expression.js';
import type { CompiledRuleSet, RuleConditionRow, RuleSet } from './types.js';

export * from './diagnostics.js';

/** 发码规则或引擎语义变化时递增；随编译缓存落库，平台重新编译命令据此挑出过期缓存。 */
export const RULE_COMPILER_VERSION = '1';

export type CompileRuleSetResult =
  | { readonly ok: true; readonly compiled: CompiledRuleSet; readonly warnings: readonly RuleWarning[] }
  | { readonly ok: false; readonly errors: readonly RuleCompileError[] };

const tooLarge = (): CompileRuleSetResult => ({ ok: false, errors: [{ code: 'RULE_TOO_LARGE' }] });
const byRowNo = (a: RuleCompileError, b: RuleCompileError) => (a.rowNo ?? 0) - (b.rowNo ?? 0);

/** 行号须为正整数且不重复；重复的行号只报一次，且这些行不再往下校验。 */
function numberingErrors(rows: readonly RuleConditionRow[]): {
  errors: RuleCompileError[];
  skipped: Set<RuleConditionRow>;
} {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.rowNo, (counts.get(row.rowNo) ?? 0) + 1);
  const errors: RuleCompileError[] = [];
  const skipped = new Set<RuleConditionRow>();
  const reported = new Set<number>();
  for (const row of rows) {
    const bad = !Number.isInteger(row.rowNo) || row.rowNo < 1 || (counts.get(row.rowNo) ?? 0) > 1;
    if (!bad) continue;
    skipped.add(row);
    if (reported.has(row.rowNo)) continue;
    reported.add(row.rowNo);
    errors.push({ code: 'RULE_ROW_INVALID', rowNo: row.rowNo, reason: 'ROW_NO_INVALID' });
  }
  return { errors, skipped };
}

interface Emission {
  readonly formula: string;
  readonly rowSpans: CompiledRuleSet['rowSpans'];
}

/** 组合式展开：行引用 → `(<子式>)`（带守卫的子式自带括号，不重复加）；and / or 中缀；整体 `IF(<组合>, 1, 0)`。 */
function emit(root: RowExpressionNode, codes: ReadonlyMap<number, RowCode>): Emission {
  let out = 'IF(';
  const rowSpans: { rowNo: number; start: number; end: number }[] = [];
  const walk = (node: RowExpressionNode, parent?: 'and' | 'or'): void => {
    if (node.kind === 'row') {
      const code = codes.get(node.rowNo)!;
      const start = out.length;
      out += code.parenthesized ? code.text : `(${code.text})`;
      rowSpans.push({ rowNo: node.rowNo, start, end: out.length });
      return;
    }
    const wrap = node.kind === 'or' && parent === 'and';
    if (wrap) out += '(';
    node.operands.forEach((operand, index) => {
      if (index > 0) out += ` ${node.kind} `;
      walk(operand, node.kind);
    });
    if (wrap) out += ')';
  };
  walk(root);
  out += ', 1, 0)';
  return { formula: out, rowSpans };
}

function exceedsEngineLimits(formula: string): boolean {
  if (formula.length > MAX_FORMULA_LENGTH) return true;
  try {
    return tokenize(formula).length > MAX_FORMULA_TOKENS;
  } catch {
    return false; // 词法问题交给 validateFormula 按行定位
  }
}

/** 引擎校验：错误（含类型推导不确定的提示，DEC-287 补充）按 offset 定位回条件行，不透出引擎文案。 */
function engineErrors(emission: Emission, codes: ReadonlyMap<number, RowCode>, refs: ReadonlySet<number>) {
  const paths = new Map<string, ExpressionFieldKind>();
  for (const rowNo of refs) {
    const code = codes.get(rowNo)!;
    paths.set(code.path, code.engineKind);
  }
  const result = validateFormula(emission.formula, {
    isKnownField: (path) => paths.has(path),
    fieldKind: (path) => paths.get(path),
  });
  const issues = result.ok ? result.warnings : result.errors;
  return issues.map((issue): RuleCompileError => {
    const rowNo = locateRuleRow(emission.rowSpans, issue.offset);
    return rowNo === undefined
      ? { code: 'RULE_EXPRESSION_SYNTAX', offset: issue.offset }
      : { code: 'RULE_ROW_INVALID', rowNo, reason: 'ENGINE' };
  });
}

const ascending = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

export function compileRuleSet(
  ruleSet: RuleSet,
  catalog: RuleFieldCatalog,
  options: CompileRuleSetOptions = {},
): CompileRuleSetResult {
  const { rows } = ruleSet;
  if (rows.length > RULE_LIMITS.maxRows) return tooLarge();

  const numbering = numberingErrors(rows);
  const rowErrors = [...numbering.errors];
  const codes = new Map<number, RowCode>();
  for (const row of rows) {
    if (numbering.skipped.has(row)) continue;
    const built = buildRowCode(row, catalog, options);
    if (built.ok) codes.set(row.rowNo, built.code);
    else rowErrors.push(built.error);
  }
  rowErrors.sort(byRowNo);

  const parsed = parseRowExpression(ruleSet.expression);
  const expressionErrors: RuleCompileError[] = [];
  // 重复行号已在上面报过，这里仍算“存在”，避免同一问题再报一条 RULE_ROW_UNKNOWN
  const knownRows = new Set(rows.map((row) => row.rowNo));
  if (!parsed.ok) expressionErrors.push(parsed.error);
  else {
    const unknown = new Set<number>();
    for (const ref of parsed.refs) {
      if (knownRows.has(ref.rowNo) || unknown.has(ref.rowNo)) continue;
      unknown.add(ref.rowNo);
      expressionErrors.push({ code: 'RULE_ROW_UNKNOWN', rowNo: ref.rowNo, offset: ref.offset });
    }
  }
  const errors = [...rowErrors, ...expressionErrors];
  if (errors.length > 0 || !parsed.ok) return { ok: false, errors };

  const emission = emit(parsed.root, codes);
  if (exceedsEngineLimits(emission.formula)) return tooLarge();
  const referenced = new Set(parsed.refs.map((ref) => ref.rowNo));
  const engine = engineErrors(emission, codes, referenced);
  if (engine.length > 0) return { ok: false, errors: engine };

  const referencedRows = ascending(referenced);
  const unreferencedRows = ascending([...codes.keys()].filter((rowNo) => !referenced.has(rowNo)));
  const constantFalseRows = ascending([...codes].filter(([, code]) => code.valueMissing).map(([rowNo]) => rowNo));
  const warnings: RuleWarning[] = [
    ...constantFalseRows.map((rowNo): RuleWarning => ({ code: 'RULE_ROW_VALUE_MISSING', rowNo })),
    ...unreferencedRows.map((rowNo): RuleWarning => ({ code: 'RULE_ROW_UNREFERENCED', rowNo })),
  ];
  return {
    ok: true,
    compiled: {
      formula: emission.formula,
      rowSpans: emission.rowSpans,
      referencedRows,
      unreferencedRows,
      constantFalseRows,
      compilerVersion: RULE_COMPILER_VERSION,
    },
    warnings,
  };
}
