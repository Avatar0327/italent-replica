/**
 * 使用方接口（REQ-EXP-001 第 5 条）：校验公式、单个求值、计算项目排序与批量求值。
 * 失败一律以结构化结果返回（`26` §8.4），不抛未捕获异常。
 */
import { walkProgram, type Program } from './ast.js';
import { isValidTimeZone } from '../tenant-time.js';
import type { BatchContext, EvaluationCalendar, EvaluationContext } from './context.js';
import { parseDateText } from './dates.js';
import { Evaluator } from './evaluator.js';
import { ComputationError, FAILURE_PREFIX, PARSER_MESSAGE, type ComputationFailure } from './failures.js';
import { parseFormula } from './parser.js';
import type { SyntaxIssue } from './lexer.js';
import type { SubjectReader } from './ports.js';
import { arityOf, createDefaultRegistry, type FunctionRegistry } from './registry.js';
import { formatIsoLike, type ExprValue, type PlainValue } from './values.js';

export type ValidationResult =
  | {
      readonly ok: true;
      readonly program: Program;
      /** 引用到的字段路径（含不带前缀、且不是 Def 变量的名字），按出现顺序去重。 */
      readonly fields: readonly string[];
      /** 用到的函数规范名，去重。 */
      readonly functions: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly SyntaxIssue[] };

export interface ValidationOptions {
  readonly registry?: FunctionRegistry;
}

function collectReferences(
  program: Program,
  registry: FunctionRegistry,
): { fields: string[]; functions: string[]; issues: SyntaxIssue[] } {
  const defined = new Set(program.definitions.map((definition) => definition.name));
  const fields = new Set<string>();
  const functions = new Set<string>();
  const issues: SyntaxIssue[] = [];
  walkProgram(program, (node) => {
    if (node.type === 'field') fields.add(node.text);
    if (node.type === 'identifier' && !defined.has(node.name)) fields.add(node.name);
    if (node.type !== 'call') return;
    const spec = registry.resolve(node.name);
    const length = node.name.length;
    if (!spec)
      return void issues.push({ code: 'UNKNOWN_FUNCTION', message: `未知函数 ${node.name}`, length, ...node.pos });
    functions.add(spec.name);
    const { min, max } = arityOf(spec);
    if (node.args.length < min || node.args.length > max) {
      const message = `函数 ${node.name} 的参数个数不对：需要 ${min}${max === Number.POSITIVE_INFINITY ? ' 个以上' : `～${max} 个`}`;
      issues.push({ code: 'ARGUMENT_COUNT', message, length, ...node.pos });
    }
  });
  return { fields: [...fields], functions: [...functions], issues };
}

/** 保存时校验：语法 + 函数名 + 参数个数，返回报错行 / 列（复刻改进，`26` §8.1）。 */
export function validateFormula(source: string, options: ValidationOptions = {}): ValidationResult {
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed;
  const { fields, functions, issues } = collectReferences(parsed.program, options.registry ?? createDefaultRegistry());
  if (issues.length) return { ok: false, errors: issues.sort((a, b) => a.offset - b.offset) };
  return { ok: true, program: parsed.program, fields, functions };
}

export type EvaluationResult =
  { readonly ok: true; readonly value: ExprValue } | { readonly ok: false; readonly failure: ComputationFailure };

function syntaxFailure(issue: SyntaxIssue): ComputationFailure {
  const code = issue.code === 'CHINESE_QUOTE' ? 'SYNTAX_ERROR' : issue.code;
  return {
    code,
    message: `${PARSER_MESSAGE}${issue.message}`,
    line: issue.line,
    column: issue.column,
    offset: issue.offset,
  };
}

/** 对一个对象求值；传入公式文本或已校验的语法树。 */
export function evaluateFormula(formula: string | Program, context: EvaluationContext): EvaluationResult {
  let program: Program;
  if (typeof formula === 'string') {
    const parsed = parseFormula(formula);
    if (!parsed.ok) return { ok: false, failure: syntaxFailure(parsed.errors[0]!) };
    program = parsed.program;
  } else {
    program = formula;
  }
  const invalidContext = validateContext(context.calendar);
  if (invalidContext) return { ok: false, failure: invalidContext };
  try {
    return { ok: true, value: new Evaluator(context).run(program) };
  } catch (error) {
    if (error instanceof ComputationError) return { ok: false, failure: error.failure };
    // 兜底（astra 首审 P2-5）：任何未预期异常都只给结构化结果，不透出异常内容
    return { ok: false, failure: { code: 'INTERNAL_ERROR', message: `${FAILURE_PREFIX}：内部错误` } };
  }
}

/** 计算上下文校验：时区须是合法 IANA 名，“今天”须是合法业务日期（DEC-056）。 */
export function validateContext(calendar: EvaluationCalendar): ComputationFailure | undefined {
  if (!isValidTimeZone(calendar.timeZone)) {
    return { code: 'CONTEXT_INVALID', message: `${FAILURE_PREFIX}：计算上下文的时区不合法` };
  }
  if (parseDateText(calendar.today)?.precision !== 'date') {
    return { code: 'CONTEXT_INVALID', message: `${FAILURE_PREFIX}：计算上下文的“今天”不是合法日期` };
  }
  return undefined;
}

// ---------- 计算项目：优先级 + 依赖拓扑（`26` §3.5 TR-R27） ----------

export interface ComputationItem {
  /** 写入的字段路径（如 盘点对象.综合得分）。 */
  readonly field: string;
  /** 数字越小越先算。 */
  readonly priority: number;
  readonly formula: string;
  readonly description?: string;
}

export type OrderingFailure =
  | { readonly code: 'CYCLIC_DEPENDENCY'; readonly message: string; readonly cycle: readonly string[] }
  | ({ readonly code: SyntaxIssue['code']; readonly message: string; readonly field: string } & Pick<
      SyntaxIssue,
      'line' | 'column' | 'offset'
    >);

export interface OrderedItem {
  readonly item: ComputationItem;
  readonly program: Program;
  /** 依赖的其他计算项目的字段。 */
  readonly dependsOn: readonly string[];
}

export type OrderingResult =
  | {
      readonly ok: true;
      readonly order: readonly ComputationItem[];
      readonly entries: readonly OrderedItem[];
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly failure: OrderingFailure };

const lastSegment = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/**
 * 公式里的字段引用 → 计算项目的目标字段：完整路径精确匹配；不带对象前缀的短名只在**唯一**一个目标字段
 * 以它结尾时匹配，有歧义则不匹配。依赖排序与批量求值的结果叠加共用本规则（astra 首审 P2-3）。
 */
export function resolveComputedField(ref: string, targets: Iterable<string>): string | undefined {
  const all = [...targets];
  if (all.includes(ref)) return ref;
  if (ref.includes('.')) return undefined;
  const candidates = all.filter((target) => lastSegment(target) === ref);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function parseItems(items: readonly ComputationItem[], registry: FunctionRegistry): OrderedItem[] | OrderingFailure {
  const targets = new Map(items.map((item) => [item.field, item]));
  const entries: OrderedItem[] = [];
  for (const item of items) {
    const validated = validateFormula(item.formula, { registry });
    if (!validated.ok) {
      const issue = validated.errors[0]!;
      return {
        code: issue.code,
        message: issue.message,
        field: item.field,
        line: issue.line,
        column: issue.column,
        offset: issue.offset,
      };
    }
    // 自引用也保留：盘点对象.a = 盘点对象.a + 1 是循环依赖（astra 首审 P2-4）
    const dependsOn = validated.fields
      .map((ref) => resolveComputedField(ref, targets.keys()))
      .filter((ref): ref is string => ref !== undefined);
    entries.push({ item, program: validated.program, dependsOn: [...new Set(dependsOn)] });
  }
  return entries;
}

function findCycle(entries: readonly OrderedItem[], remaining: ReadonlySet<string>): string[] {
  const byField = new Map(entries.map((entry) => [entry.item.field, entry]));
  const path: string[] = [];
  const visit = (field: string): string[] | undefined => {
    const seen = path.indexOf(field);
    if (seen >= 0) return [...path.slice(seen), field];
    path.push(field);
    for (const dependency of byField.get(field)?.dependsOn ?? []) {
      if (!remaining.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    return undefined;
  };
  for (const entry of entries) {
    if (!remaining.has(entry.item.field)) continue;
    const cycle = visit(entry.item.field);
    if (cycle) return cycle;
  }
  return [];
}

/** Kahn 拓扑排序：可算的项目里先取优先级小、再取原顺序靠前的；有依赖矛盾时以依赖为准并给出提示。 */
function topologicalOrder(entries: readonly OrderedItem[]): { order: OrderedItem[]; warnings: string[] } | string[] {
  const byField = new Map(entries.map((entry) => [entry.item.field, entry]));
  const index = new Map(entries.map((entry, i) => [entry.item.field, i]));
  const remaining = new Set(entries.map((entry) => entry.item.field));
  const order: OrderedItem[] = [];
  const warnings: string[] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .map((field) => byField.get(field)!)
      .filter((entry) => entry.dependsOn.every((dependency) => !remaining.has(dependency)))
      .sort((a, b) => a.item.priority - b.item.priority || index.get(a.item.field)! - index.get(b.item.field)!);
    const next = ready[0];
    if (!next) return findCycle(entries, remaining);
    for (const dependency of next.dependsOn) {
      const upstream = byField.get(dependency)!.item;
      if (upstream.priority > next.item.priority) {
        const detail = `引用了 ${dependency}（优先级 ${upstream.priority}），按依赖先算 ${dependency}`;
        warnings.push(`${next.item.field}（优先级 ${next.item.priority}）${detail}`);
      }
    }
    remaining.delete(next.item.field);
    order.push(next);
  }
  return { order, warnings };
}

/** 计算项目排序：先优先级，再按引用依赖拓扑；循环依赖报错并列出环（TODO(需取证 Q-M0-84)：原站同优先级 / 循环时的处理）。 */
export function orderComputationItems(
  items: readonly ComputationItem[],
  options: ValidationOptions = {},
): OrderingResult {
  const parsed = parseItems(items, options.registry ?? createDefaultRegistry());
  if (!Array.isArray(parsed)) return { ok: false, failure: parsed };
  const sorted = topologicalOrder(parsed);
  if (Array.isArray(sorted)) {
    const message = `计算项目之间存在循环依赖：${sorted.join(' → ')}`;
    return { ok: false, failure: { code: 'CYCLIC_DEPENDENCY', message, cycle: sorted } };
  }
  return { ok: true, order: sorted.order.map((entry) => entry.item), entries: sorted.order, warnings: sorted.warnings };
}

// ---------- 批量求值 ----------

export type BatchResult =
  | {
      readonly ok: true;
      readonly order: readonly string[];
      readonly warnings: readonly string[];
      /** 对象 ID → 字段 → 值或失败原因。 */
      readonly results: Readonly<Record<string, Readonly<Record<string, EvaluationResult>>>>;
    }
  | { readonly ok: false; readonly failure: OrderingFailure };

function toPlain(value: ExprValue): PlainValue {
  switch (value.kind) {
    case 'empty':
      return null;
    case 'date':
      return formatIsoLike(value.value);
    case 'option':
      return value.label === undefined
        ? { optionValue: value.value }
        : { optionValue: value.value, label: value.label };
    default:
      return value.value;
  }
}

/** 先算项目的结果叠加在对象字段之上，供后算项目与排名范围读取。 */
function withComputed(subject: SubjectReader, computed: Readonly<Record<string, ExprValue>>): SubjectReader {
  return {
    id: subject.id,
    resolveField: (path) => {
      const target = resolveComputedField(path, Object.keys(computed));
      return target === undefined ? subject.resolveField(path) : { status: 'found', value: toPlain(computed[target]!) };
    },
  };
}

const dependencyFailure = (field: string, dependency: string): EvaluationResult => ({
  ok: false,
  failure: { code: 'DEPENDENCY_FAILED', message: `计算失败：${field} 依赖的 ${dependency} 未能算出` },
});

/** 对一组对象按计算项目批量求值：每个对象得到每个字段的值或失败原因；一个对象失败不影响其他对象。 */
export function evaluateBatch(
  items: readonly ComputationItem[],
  subjects: readonly SubjectReader[],
  context: BatchContext,
): BatchResult {
  const registry = context.registry ?? createDefaultRegistry();
  const ordered = orderComputationItems(items, { registry });
  if (!ordered.ok) return ordered;
  const computed = new Map(subjects.map((subject) => [subject.id, {} as Record<string, ExprValue>]));
  const results: Record<string, Record<string, EvaluationResult>> = Object.fromEntries(
    subjects.map((subject) => [subject.id, {}]),
  );
  for (const entry of ordered.entries) {
    const field = entry.item.field;
    const failedDependency = (id: string) =>
      entry.dependsOn.find((dependency) => !Object.hasOwn(computed.get(id)!, dependency));
    const population = subjects.filter((subject) => failedDependency(subject.id) === undefined);
    const ranking = context.ports?.ranking ?? {
      population: () => ({
        ok: true as const,
        data: population.map((subject) => withComputed(subject, computed.get(subject.id)!)),
      }),
    };
    for (const subject of subjects) {
      const dependency = failedDependency(subject.id);
      if (dependency !== undefined) {
        results[subject.id]![field] = dependencyFailure(field, dependency);
        continue;
      }
      const reader = withComputed(subject, computed.get(subject.id)!);
      const result = evaluateFormula(entry.program, {
        ...context,
        registry,
        subject: reader,
        ports: { ...context.ports, ranking },
      });
      results[subject.id]![field] = result;
      if (result.ok) computed.get(subject.id)![field] = result.value;
    }
  }
  return { ok: true, order: ordered.order.map((item) => item.field), warnings: ordered.warnings, results };
}
