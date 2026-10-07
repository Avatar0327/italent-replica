/**
 * 使用方接口（REQ-EXP-001 第 5 条）：校验公式、单个求值、计算项目排序与批量求值。
 * 失败一律以结构化结果返回（`26` §8.4），不抛未捕获异常。
 */
import { childrenOf, type CallNode, type ExprNode, type Program } from './ast.js';
import { isValidTimeZone } from '../tenant-time.js';
import type { BatchContext, EvaluationCalendar, EvaluationContext } from './context.js';
import { instantToParts, parseDateText } from './dates.js';
import { Evaluator } from './evaluator.js';
import {
  ComputationError,
  FAILURE_PREFIX,
  hyphenHint,
  PARSER_MESSAGE,
  type ComputationFailure,
  type SourcePosition,
} from './failures.js';
import { parseFormula } from './parser.js';
import type { SyntaxIssue } from './lexer.js';
import type { SubjectReader } from './ports.js';
import {
  arityOf,
  createDefaultRegistry,
  type FunctionRegistry,
  type FunctionSpec,
  type StaticKind,
} from './registry.js';
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
  /**
   * 字段目录：完整字段路径或短字段名是否存在。传入时保存校验报未知字段（UNKNOWN_FIELD，含“-”时提示
   * “如需相减，请在减号两侧加空格”，DEC-228）；不传时只查语法、函数名、参数个数，引用到的字段在结果的 fields 里。
   */
  readonly isKnownField?: (path: string) => boolean;
}

const NO_RECORDS: ReadonlySet<string> = new Set();

/**
 * 保存时的静态检查：函数名、参数个数；传入字段目录时再查未知字段。Def 变量只在定义之后可用；
 * 取数函数参数里的记录对象字段（如 考核结果.年度）按端口记录求值，不按对象字段目录检查（FunctionSpec.recordObjects）。
 */
class ReferenceCollector {
  readonly fields = new Set<string>();
  readonly functions = new Set<string>();
  readonly issues: SyntaxIssue[] = [];
  private readonly defined = new Set<string>();

  constructor(
    private readonly registry: FunctionRegistry,
    private readonly isKnownField?: (path: string) => boolean,
  ) {}

  collect(program: Program): this {
    for (const definition of program.definitions) {
      this.visit(definition.value, NO_RECORDS);
      this.defined.add(definition.name);
    }
    this.visit(program.body, NO_RECORDS);
    return this;
  }

  private visit(node: ExprNode, records: ReadonlySet<string>): void {
    if (node.type === 'field') return this.reference(node.text, node.pos, records.has(node.path[0]!));
    if (node.type === 'identifier')
      return this.defined.has(node.name) ? undefined : this.reference(node.name, node.pos);
    if (node.type === 'call') return this.call(node, records);
    for (const child of childrenOf(node)) this.visit(child, records);
  }

  private reference(path: string, pos: SourcePosition, fromRecord = false): void {
    this.fields.add(path);
    if (fromRecord || !this.isKnownField) return;
    let known: boolean;
    try {
      known = this.isKnownField(path);
    } catch {
      // 字段目录是使用方代码：出错时无法确认字段存在，按未知字段拒绝保存（fail-closed），不透出异常内容
      const message = `无法确认字段 ${path} 是否存在（字段目录读取出错）`;
      return void this.issues.push({ code: 'UNKNOWN_FIELD', message, length: path.length, ...pos });
    }
    if (known) return;
    const message = `找不到字段或变量 ${path}${hyphenHint(path)}`;
    this.issues.push({ code: 'UNKNOWN_FIELD', message, length: path.length, ...pos });
  }

  /**
   * 日期函数的日期参数静态可知不是日期时拦截（DEC-270，`26` §8.8 原站【检查】：
   * “AddDays(,)函数的第1个参数应为日期或日期时间字段或常量”）；字段、变量等运行期才知道类型的不拦截。
   */
  private checkDateParams(node: CallNode, spec: FunctionSpec): void {
    for (const index of spec.dateParams ?? []) {
      const arg = node.args[index];
      const kind = arg ? staticKind(arg, this.registry) : undefined;
      if (kind === undefined || kind === 'date') continue;
      const message = `${node.name}函数的第${index + 1}个参数应为日期或日期时间字段或常量`;
      this.issues.push({ code: 'ARGUMENT_TYPE', message, length: node.name.length, ...node.pos });
    }
  }

  private call(node: CallNode, records: ReadonlySet<string>): void {
    const spec = this.registry.resolve(node.name);
    const length = node.name.length;
    if (!spec) {
      this.issues.push({ code: 'UNKNOWN_FUNCTION', message: `未知函数 ${node.name}`, length, ...node.pos });
    } else {
      this.functions.add(spec.name);
      const { min, max } = arityOf(spec);
      if (node.args.length < min || node.args.length > max) {
        const expected = max === Number.POSITIVE_INFINITY ? ' 个以上' : `～${max} 个`;
        const message = `函数 ${node.name} 的参数个数不对：需要 ${min}${expected}`;
        this.issues.push({ code: 'ARGUMENT_COUNT', message, length, ...node.pos });
      }
      this.checkDateParams(node, spec);
    }
    const inner = spec?.recordObjects?.length ? new Set([...records, ...spec.recordObjects]) : records;
    for (const arg of node.args) this.visit(arg, inner);
  }
}

/** 能静态确定的值类型；字段、变量、如果 / IF 等取决于数据的返回 undefined。 */
function staticKind(node: ExprNode, registry: FunctionRegistry): StaticKind | undefined {
  switch (node.type) {
    case 'number':
    case 'unary':
      return 'number';
    case 'string':
      return parseDateText(node.value) ? 'date' : 'text';
    case 'boolean':
    case 'logical':
      return 'boolean';
    case 'binary':
      return ['+', '-', '*', '/'].includes(node.operator) ? 'number' : 'boolean';
    case 'call':
      return registry.resolve(node.name)?.returns;
    default:
      return undefined;
  }
}

/** 保存时校验：语法 + 函数名 + 参数个数（+ 传入字段目录时的未知字段），返回报错行 / 列（复刻改进，`26` §8.1）。 */
export function validateFormula(source: string, options: ValidationOptions = {}): ValidationResult {
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed;
  const registry = options.registry ?? createDefaultRegistry();
  const collected = new ReferenceCollector(registry, options.isKnownField).collect(parsed.program);
  if (collected.issues.length) return { ok: false, errors: collected.issues.sort((a, b) => a.offset - b.offset) };
  return { ok: true, program: parsed.program, fields: [...collected.fields], functions: [...collected.functions] };
}

export type EvaluationResult =
  { readonly ok: true; readonly value: ExprValue } | { readonly ok: false; readonly failure: ComputationFailure };

function syntaxFailure(issue: SyntaxIssue): ComputationFailure {
  return {
    code: issue.code,
    message: `${PARSER_MESSAGE}${issue.message}`,
    line: issue.line,
    column: issue.column,
    offset: issue.offset,
  };
}

/**
 * 对一个对象求值；传入公式文本或已校验的语法树。公式文本先走与保存校验、批量求值相同的静态检查
 * （语法、函数名、参数个数），三条入口对同一公式同一解释（DEC-228）。
 */
export function evaluateFormula(formula: string | Program, context: EvaluationContext): EvaluationResult {
  let program: Program;
  if (typeof formula === 'string') {
    const validated = validateFormula(formula, { registry: context.registry });
    if (!validated.ok) return { ok: false, failure: syntaxFailure(validated.errors[0]!) };
    program = validated.program;
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
  const { now } = calendar;
  if (now === undefined) return undefined;
  // “现在”与“今天”须在租户时区下是同一天（DEC-265），否则 Now() 与 Today() 自相矛盾
  const nowDay = Number.isNaN(now.getTime())
    ? undefined
    : formatIsoLike({ ...instantToParts(now, calendar.timeZone), precision: 'date' });
  if (nowDay !== calendar.today) {
    return { code: 'CONTEXT_INVALID', message: `${FAILURE_PREFIX}：计算上下文的“现在”与“今天”不是同一天` };
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
  | {
      readonly code: 'CYCLIC_DEPENDENCY';
      readonly message: string;
      /** 第一个环；全部环见 cycles。 */
      readonly cycle: readonly string[];
      readonly cycles: readonly (readonly string[])[];
    }
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

/** 公式里的字段引用 → 计算项目目标字段的固定绑定；排序与求值共用，不随计算顺序变化（astra 二轮 P2-2）。 */
export type FieldBindings = Readonly<Record<string, string>>;

export type OrderingResult =
  | {
      readonly ok: true;
      readonly order: readonly ComputationItem[];
      readonly entries: readonly OrderedItem[];
      readonly bindings: FieldBindings;
      readonly warnings: readonly string[];
      /**
       * 循环依赖的路径（如 [A, B, A]），每个环一条（DEC-274）：保存时只提示、不拦截；计算时整次失败。
       */
      readonly cycles: readonly (readonly string[])[];
      /** 成环或依赖成环项目、因而无法计算的项目（按原顺序），排在 order 末尾。 */
      readonly blocked: readonly string[];
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

interface ParsedItems {
  readonly entries: OrderedItem[];
  readonly bindings: FieldBindings;
}

interface ItemValidation {
  readonly registry: FunctionRegistry;
  readonly isKnownField?: (path: string) => boolean;
}

/** 解析全部公式，再用全部目标字段一次性确定每个引用的绑定，依赖关系由绑定推出。 */
function parseItems(items: readonly ComputationItem[], options: ItemValidation): ParsedItems | OrderingFailure {
  const targets = items.map((item) => item.field);
  const catalog = options.isKnownField;
  // 传入字段目录时，计算项目的目标字段（含唯一短名）也视为已知：后算项目可以引用先算项目的结果
  const isKnownField = catalog
    ? (path: string) => resolveComputedField(path, targets) !== undefined || catalog(path)
    : undefined;
  const parsed: { item: ComputationItem; program: Program; refs: readonly string[] }[] = [];
  for (const item of items) {
    const validated = validateFormula(item.formula, { registry: options.registry, isKnownField });
    if (!validated.ok) {
      const issue = validated.errors[0]!;
      const { line, column, offset } = issue;
      return { code: issue.code, message: issue.message, field: item.field, line, column, offset };
    }
    parsed.push({ item, program: validated.program, refs: validated.fields });
  }
  const bindings: Record<string, string> = {};
  for (const ref of new Set(parsed.flatMap((entry) => entry.refs))) {
    const target = resolveComputedField(ref, targets);
    if (target !== undefined) bindings[ref] = target;
  }
  // 自引用也保留：盘点对象.a = 盘点对象.a + 1 是循环依赖（astra 首审 P2-4）
  const entries = parsed.map(({ item, program, refs }) => {
    const dependsOn = refs.map((ref) => bindings[ref]).filter((target): target is string => target !== undefined);
    return { item, program, dependsOn: [...new Set(dependsOn)] };
  });
  return { entries, bindings };
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

/** 在 within 范围内沿依赖能否从 from 走到 to（至少走一步）。 */
function reaches(
  byField: ReadonlyMap<string, OrderedItem>,
  from: string,
  to: string,
  within: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [...(byField.get(from)?.dependsOn ?? [])];
  while (stack.length) {
    const field = stack.pop()!;
    if (field === to) return true;
    if (!within.has(field) || seen.has(field)) continue;
    seen.add(field);
    stack.push(...(byField.get(field)?.dependsOn ?? []));
  }
  return false;
}

/** 无法排序的项目里的全部环：按强连通分量分组，每组给出一条路径（如 A→B→A），按原顺序排列。 */
function cyclesAmong(entries: readonly OrderedItem[], blocked: readonly string[]): string[][] {
  const byField = new Map(entries.map((entry) => [entry.item.field, entry]));
  const within = new Set(blocked);
  const assigned = new Set<string>();
  const cycles: string[][] = [];
  for (const field of blocked) {
    if (assigned.has(field) || !reaches(byField, field, field, within)) continue;
    const component = new Set(
      blocked.filter(
        (other) =>
          other === field || (reaches(byField, field, other, within) && reaches(byField, other, field, within)),
      ),
    );
    component.forEach((member) => assigned.add(member));
    cycles.push(findCycle(entries, component));
  }
  return cycles;
}

interface Topology {
  readonly order: OrderedItem[];
  readonly warnings: string[];
  /** 成环或依赖成环项目、排不出顺序的项目（按原顺序）。 */
  readonly blocked: OrderedItem[];
}

/** Kahn 拓扑排序：可算的项目里先取优先级小、再取原顺序靠前的；有依赖矛盾时以依赖为准并给出提示。 */
function topologicalOrder(entries: readonly OrderedItem[]): Topology {
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
    if (!next) break;
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
  return { order, warnings, blocked: entries.filter((entry) => remaining.has(entry.item.field)) };
}

const cyclePath = (cycle: readonly string[]) => cycle.join('→');

/**
 * 计算项目排序（计算规则保存 / 启用时调用）：先优先级，同优先级内按引用依赖拓扑（`26` §8.9 原站实测）；
 * 传入字段目录时同保存校验报未知字段。循环依赖不拦截保存（DEC-274）：在 cycles / warnings 里列出成环的项目与
 * 依赖路径，成环与受牵连的项目排在 order 末尾；计算时由 evaluateBatch 整次失败。
 */
export function orderComputationItems(
  items: readonly ComputationItem[],
  options: ValidationOptions = {},
): OrderingResult {
  const registry = options.registry ?? createDefaultRegistry();
  const parsed = parseItems(items, { registry, isKnownField: options.isKnownField });
  if (!('entries' in parsed)) return { ok: false, failure: parsed };
  const sorted = topologicalOrder(parsed.entries);
  const blocked = sorted.blocked.map((entry) => entry.item.field);
  const cycles = cyclesAmong(parsed.entries, blocked);
  const inCycle = new Set(cycles.flat());
  const cycleWarnings = [
    ...cycles.map((cycle) => `检测到循环依赖：${cyclePath(cycle)}（允许保存，计算时将整次失败、不写入任何值）`),
    ...blocked.filter((field) => !inCycle.has(field)).map((field) => `${field} 依赖成环的项目，计算时同样无法计算`),
  ];
  const entries = [...sorted.order, ...sorted.blocked];
  return {
    ok: true,
    order: entries.map((entry) => entry.item),
    entries,
    bindings: parsed.bindings,
    warnings: [...sorted.warnings, ...cycleWarnings],
    cycles,
    blocked,
  };
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

/** 先算项目的结果叠加在对象字段之上，供后算项目与排名范围读取；引用只按固定绑定查结果，不绑定的读对象自身字段。 */
function withComputed(
  subject: SubjectReader,
  computed: Readonly<Record<string, ExprValue>>,
  bindings: FieldBindings,
): SubjectReader {
  return {
    id: subject.id,
    resolveField: (path) => {
      const target = bindings[path];
      if (target !== undefined && Object.hasOwn(computed, target)) {
        return { status: 'found', value: toPlain(computed[target]!) };
      }
      return subject.resolveField(path);
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
  if (ordered.cycles.length) {
    // DEC-274：存在循环时整次计算不写入任何值（原站同样整次跳过），但明确报失败而不是“计算成功”
    const message = `计算失败：循环依赖 ${ordered.cycles.map(cyclePath).join('；')}`;
    const failure = { code: 'CYCLIC_DEPENDENCY', message, cycle: ordered.cycles[0]!, cycles: ordered.cycles } as const;
    return { ok: false, failure };
  }
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
        data: population.map((subject) => withComputed(subject, computed.get(subject.id)!, ordered.bindings)),
      }),
    };
    for (const subject of subjects) {
      const dependency = failedDependency(subject.id);
      if (dependency !== undefined) {
        results[subject.id]![field] = dependencyFailure(field, dependency);
        continue;
      }
      const reader = withComputed(subject, computed.get(subject.id)!, ordered.bindings);
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
