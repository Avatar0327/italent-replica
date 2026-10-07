/**
 * 统一的静态类型推导（DEC-287①）：对每个语法节点（字面量、字段、函数返回、Def、IF / 如果、运算）给出类型。
 * 保存时的日期参数检查（DEC-270②）与第 N 年 / 第 N 次“是否型过滤条件还是数值 N”的区分都只认这里的结果，
 * 不再按写法逐个特判（DEC-285②）。
 *
 * 类型是确定的一种（数值 / 文本 / 是否 / 日期），或“不确定”。IF / 如果 取各分支的合并：一致为该类型，不一致记为不确定，
 * 并保留各分支可能的类型（candidates），用来判断“无论走哪一支都不可能是日期”；有分支可能的类型未知时 candidates 也未知。
 * 字段的类型来自使用方传入的字段类型目录（没有目录、目录里没有或读取出错时不确定）；取数函数的记录字段（考核结果.* 等）
 * 来自端口记录，一律不确定。
 */
import type { CallNode, ExprNode } from './ast.js';
import { parseDateText } from './dates.js';
import type { FunctionRegistry } from './registry.js';
import type { StaticKind } from './values.js';

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
const NO_RECORDS: ReadonlySet<string> = new Set();

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

export interface TypeInferenceOptions {
  readonly registry: FunctionRegistry;
  /** 字段类型目录（完整字段路径或短字段名）；没有、返回 undefined 或读取出错时该字段不确定。 */
  readonly fieldKind?: (path: string) => StaticKind | undefined;
}

export class TypeInference {
  private readonly defs = new Map<string, InferredType>();

  constructor(private readonly options: TypeInferenceOptions) {}

  /** 按定义顺序登记 Def 变量：之后同名引用取定义值的类型，重新定义取最后一次。 */
  define(name: string, value: ExprNode): void {
    this.defs.set(name, this.infer(value));
  }

  /** records：所在取数函数的记录对象名（如 考核结果），这些对象下的字段按不确定处理。 */
  infer(node: ExprNode, records: ReadonlySet<string> = NO_RECORDS): InferredType {
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
    const inner = spec.recordObjects?.length ? new Set([...records, ...spec.recordObjects]) : records;
    const merged = spec.returnsFromArgs
      .map((index) => node.args[index])
      .filter((arg): arg is ExprNode => arg !== undefined)
      .map((arg) => this.infer(arg, inner));
    return mergeTypes(merged);
  }

  private catalog(path: string): InferredType {
    let kind: StaticKind | undefined;
    try {
      kind = this.options.fieldKind?.(path);
    } catch {
      // 字段类型目录是使用方代码：读不出时按不确定处理，由保存提示与计算期判断兜底
      return UNCERTAIN;
    }
    return kind !== undefined && Object.hasOwn(DEFINITE, kind) ? DEFINITE[kind] : UNCERTAIN;
  }
}
