/**
 * 统一的静态类型推导（DEC-287①）：对每个语法节点（字面量、字段、函数返回、Def、IF / 如果、运算）给出类型。
 * 保存时的日期参数检查（DEC-270②）、第 N 年 / 第 N 次“是否型过滤条件还是数值 N”的区分、运行期空值的来源类型
 * 都只认这里的结果，不再按写法逐个特判（DEC-285②）。保存检查与运行期按同一顺序登记 Def（先推右侧、再登记）。
 *
 * 类型是确定的一种（数值 / 文本 / 是否 / 日期），或“不确定”。IF / 如果 取各分支的合并：一致为该类型，不一致记为不确定，
 * 并保留各分支可能的类型（candidates），用来判断“无论走哪一支都不可能是日期”；有分支可能的类型未知时 candidates 也未知。
 * 字段的类型来自使用方传入的字段类型目录（没有目录、目录里没有或读取出错时不确定）；取数函数的记录字段（考核结果.* 等）
 * 来自端口记录，一律不确定。
 */
import type { CallNode, ExprNode } from './ast.js';
import { parseDateText } from './dates.js';
import type { FunctionRegistry, FunctionSpec } from './registry.js';
import type { ExpressionFieldKind, StaticKind } from './values.js';

export type InferredType =
  | { readonly kind: StaticKind }
  | {
      readonly kind: 'uncertain';
      /** 可能的类型（至少两种）；不写表示可能的类型未知。 */
      readonly candidates?: ReadonlySet<StaticKind>;
    };

const UNCERTAIN: InferredType = Object.freeze({ kind: 'uncertain' } as const);

const DEFINITE: Readonly<Record<StaticKind, InferredType>> = Object.freeze({
  number: Object.freeze({ kind: 'number' } as const),
  text: Object.freeze({ kind: 'text' } as const),
  boolean: Object.freeze({ kind: 'boolean' } as const),
  date: Object.freeze({ kind: 'date' } as const),
});

const ARITHMETIC = new Set(['+', '-', '*', '/']);
/** 不在任何取数函数里时的记录对象范围（空）。保存检查、运行期共用同一个集合，推导缓存按它分桶。 */
export const NO_RECORDS: ReadonlySet<string> = new Set<string>();

/** 可能的类型；undefined 表示未知（什么类型都可能）。 */
function possibleKinds(type: InferredType): ReadonlySet<StaticKind> | undefined {
  return type.kind === 'uncertain' ? type.candidates : new Set([type.kind]);
}

/** 由可能的类型得到推导结果：只有一种为确定，多种为不确定。 */
function fromKinds(kinds: Iterable<StaticKind>): InferredType {
  const set = new Set(kinds);
  if (set.size === 1) return DEFINITE[[...set][0]!];
  return set.size ? { kind: 'uncertain', candidates: set } : UNCERTAIN;
}

/** 合并（IF / 如果 的各分支）：都确定且一致 → 该类型；否则不确定，可能的类型取并集（有分支未知则未知）。 */
export function mergeTypes(types: readonly InferredType[]): InferredType {
  const [first] = types;
  if (!first) return UNCERTAIN;
  if (first.kind !== 'uncertain' && types.every((type) => type.kind === first.kind)) return first;
  const union = new Set<StaticKind>();
  for (const type of types) {
    const kinds = possibleKinds(type);
    if (!kinds) return UNCERTAIN;
    for (const kind of kinds) union.add(kind);
  }
  return fromKinds(union);
}

/** 确定为某类型。 */
export function isDefinitely(type: InferredType, kind: StaticKind): boolean {
  return type.kind === kind;
}

/** 可能是某类型：确定为该类型，或不确定且可能的类型未知 / 包含该类型。 */
export function mayBe(type: InferredType, kind: StaticKind): boolean {
  const kinds = possibleKinds(type);
  return kinds === undefined || kinds.has(kind);
}

/**
 * 参数要求某类型时的判定：确定为该类型 → ok；不可能是该类型（确定为别的类型，或各可能类型都不是）→ mismatch，
 * 保存报错；其余（可能是、也可能不是）→ uncertain，保存提示。
 */
export function verdictFor(type: InferredType, expected: StaticKind): 'ok' | 'mismatch' | 'uncertain' {
  if (isDefinitely(type, expected)) return 'ok';
  return mayBe(type, expected) ? 'uncertain' : 'mismatch';
}

/** 函数的返回类型声明 → 推导结果；没有声明为不确定。 */
export function declaredType(returns: StaticKind | readonly StaticKind[] | undefined): InferredType {
  if (returns === undefined) return UNCERTAIN;
  return fromKinds(typeof returns === 'string' ? [returns] : returns);
}

/**
 * 空值的来源类型（运行期标在空值上，DEC-270②）：推导出确定类型时就是它；不确定、但各可能类型都不是日期时取其中之一
 * （日期参数据此拒绝）；可能是日期或可能类型未知时为 undefined，即来源未知。
 */
export function emptySource(type: InferredType): StaticKind | undefined {
  if (type.kind !== 'uncertain') return type.kind;
  if (!type.candidates || type.candidates.has('date')) return undefined;
  return [...type.candidates][0];
}

/** 记录对象范围按内容复用同一个集合（名字只来自函数定义，种类很少），推导缓存因此不随求值次数分出新桶。 */
const RECORD_SCOPES = new Map<string, ReadonlySet<string>>();

/** 进入函数参数后的记录对象范围：外层范围加上该函数的记录对象（取数函数的 考核结果 等）。保存检查与运行期共用。 */
export function withRecordObjects(records: ReadonlySet<string>, spec: FunctionSpec | undefined): ReadonlySet<string> {
  if (!spec?.recordObjects?.length) return records;
  const names = [...new Set([...records, ...spec.recordObjects])].sort();
  const key = names.join('\n');
  let scope = RECORD_SCOPES.get(key);
  if (!scope) RECORD_SCOPES.set(key, (scope = new Set(names)));
  return scope;
}

export interface TypeInferenceOptions {
  readonly registry: FunctionRegistry;
  /** 字段类型目录（完整字段路径或短字段名）；没有、返回 undefined 或读取出错时该字段不确定。 */
  readonly fieldKind?: (path: string) => ExpressionFieldKind | undefined;
}

export class TypeInference {
  private readonly defs = new Map<string, InferredType>();
  /**
   * 推导结果缓存（按记录对象范围、再按节点）：同一 Def 环境下同一节点的类型不变，运行期逐层标空值来源时不必重复推导
   * 子树（避免嵌套 IF 平方级）。登记 Def 会改变环境，随即清空。
   */
  private readonly cache = new Map<ReadonlySet<string>, WeakMap<ExprNode, InferredType>>();

  constructor(private readonly options: TypeInferenceOptions) {}

  /** 按定义顺序登记 Def 变量：之后同名引用取定义值的类型，重新定义取最后一次。定义值按登记之前的环境推导。 */
  define(name: string, value: ExprNode): void {
    const type = this.infer(value);
    this.defs.set(name, type);
    this.cache.clear();
  }

  /** records：所在取数函数的记录对象名（如 考核结果），这些对象下的字段按不确定处理。 */
  infer(node: ExprNode, records: ReadonlySet<string> = NO_RECORDS): InferredType {
    let known = this.cache.get(records);
    if (!known) this.cache.set(records, (known = new WeakMap()));
    let type = known.get(node);
    if (!type) known.set(node, (type = this.compute(node, records)));
    return type;
  }

  private compute(node: ExprNode, records: ReadonlySet<string>): InferredType {
    switch (node.type) {
      case 'number':
        return DEFINITE.number;
      case 'string':
        return parseDateText(node.value) ? DEFINITE.date : DEFINITE.text;
      case 'boolean':
      case 'logical':
        return DEFINITE.boolean;
      case 'unary':
        // 负号做数值转换；正号原样返回操作数（见 evaluator.ts）
        return node.operator === '-' ? DEFINITE.number : this.infer(node.operand, records);
      case 'binary':
        return ARITHMETIC.has(node.operator) ? DEFINITE.number : DEFINITE.boolean;
      case 'identifier':
        return this.defs.get(node.name) ?? this.catalog(node.name);
      case 'field':
        return records.has(node.path[0]!) ? UNCERTAIN : this.catalog(node.text);
      case 'if': {
        // 缺“否则”时不命中的结果是空值，不参与合并
        const branches = node.branches.map((branch) => branch.then);
        const all = node.otherwise ? [...branches, node.otherwise] : branches;
        return mergeTypes(all.map((branch) => this.infer(branch, records)));
      }
      case 'call':
        return this.inferCall(node, records);
    }
  }

  private inferCall(node: CallNode, records: ReadonlySet<string>): InferredType {
    const spec = this.options.registry.resolve(node.name);
    if (!spec) return UNCERTAIN;
    if (!spec.returnsFromArgs) return declaredType(spec.returns);
    const inner = withRecordObjects(records, spec);
    const merged = spec.returnsFromArgs
      .map((index) => node.args[index])
      .filter((arg): arg is ExprNode => arg !== undefined)
      .map((arg) => this.infer(arg, inner));
    return mergeTypes(merged);
  }

  private catalog(path: string): InferredType {
    let kind: ExpressionFieldKind | undefined;
    try {
      kind = this.options.fieldKind?.(path);
    } catch {
      // 字段类型目录是使用方代码：读不出时按不确定处理，由保存提示与计算期判断兜底
      return UNCERTAIN;
    }
    return kind !== undefined && kind !== 'multi_option' && Object.hasOwn(DEFINITE, kind) ? DEFINITE[kind] : UNCERTAIN;
  }
}
