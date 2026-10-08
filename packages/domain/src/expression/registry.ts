/**
 * 函数注册表（`26` §8.1）：中英文函数名同义，使用方可追加自定义函数。
 * 函数分两类：普通函数收到已求值的参数；惰性函数（取数过滤、Ranking）收到语法树并自行在记录作用域里求值。
 */
import type { CallNode, ExprNode } from './ast.js';
import type { FailureCode } from './failures.js';
import { BUILTIN_FUNCTIONS } from './functions/index.js';
import type { RankingTables } from './functions/ranking.js';
import type { DataSourcePorts, SubjectReader } from './ports.js';
import type { ExpressionSemantics } from './semantics.js';
import type { InferredType } from './typing.js';
import type { DateParts, ExprValue, PlainValue, StaticKind } from './values.js';

export type { StaticKind } from './values.js';

export interface FunctionParam {
  readonly name: string;
  readonly required: boolean;
  /** 可重复出现的尾参数（如 Average 的多个数值、取数函数的多个过滤表达式）。 */
  readonly variadic?: boolean;
  readonly description?: string;
}

/** 传给函数实现的调用对象；求值器实现这些能力，函数本身不依赖求值器内部结构。 */
export interface FunctionCall {
  readonly node: CallNode;
  /** 普通函数：已求值的参数；惰性函数：空数组。 */
  readonly args: readonly ExprValue[];
  readonly rawArgs: readonly ExprNode[];
  /** 在当前作用域（或叠加一组记录字段后的子作用域）求值一个参数节点。 */
  readonly evaluate: (node: ExprNode, recordFields?: Readonly<Record<string, ExprValue>>) => ExprValue;
  /** 以另一个对象（如排名范围内的成员）为主体求值一个参数节点。 */
  readonly evaluateForSubject: (node: ExprNode, subject: SubjectReader) => ExprValue;
  readonly fail: (code: FailureCode, detail: string) => never;
  /** 公共取参：函数的数值参数（空值按 semantics.emptyInFunctionArgument，数字文本按数值，DEC-270）。 */
  readonly numberArg: (args: readonly ExprValue[], index: number) => number;
  /** 公共取参：函数的日期参数（空值按 semantics.emptyDateArgument，默认 0001-01-01，DEC-270）。 */
  readonly dateArg: (args: readonly ExprValue[], index: number) => DateParts;
  readonly textArg: (args: readonly ExprValue[], index: number) => string;
  readonly toNumber: (value: ExprValue) => number;
  readonly toText: (value: ExprValue) => string;
  readonly toDate: (value: ExprValue) => DateParts;
  readonly toBoolean: (value: ExprValue) => boolean;
  /**
   * 参数节点的静态类型（统一类型推导，DEC-287）：Def 变量、字段类型目录与保存检查同一口径；
   * 本函数的记录对象字段（如 考核结果.*）按不确定处理。
   */
  readonly inferType: (node: ExprNode) => InferredType;
  readonly env: FunctionEnvironment;
}

/** 函数自己的保存检查结果（如第 N 年 / 第 N 次的参数角色）：error 拒绝保存，warning 只提示。 */
export interface ArgumentIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

/** 函数可见的上下文切片（不含求值器内部状态）。 */
export interface FunctionEnvironment {
  readonly subjectId: string;
  readonly calendar: { readonly today: string; readonly timeZone: string; readonly now?: Date };
  readonly project?: { readonly startAt?: Date; readonly endAt?: Date };
  readonly assessmentLatestWindow: 'before_project_end' | 'before_project_start';
  readonly semantics: ExpressionSemantics;
  readonly ports?: DataSourcePorts;
  /** 排名表缓存（见 EvaluationContext.rankingTables）。 */
  readonly rankingTables?: RankingTables;
  readonly fromPlain: (value: PlainValue) => ExprValue;
}

export interface FunctionSpec {
  /** 规范英文名。 */
  readonly name: string;
  /** 中文名与其他拼写（如 Latest360Cent）。 */
  readonly aliases: readonly string[];
  readonly params: readonly FunctionParam[];
  readonly description?: string;
  /** 为真时参数不预先求值，由实现按需在记录作用域求值。 */
  readonly lazy?: boolean;
  /**
   * 取数函数在记录作用域里求值参数时用到的对象名（如 考核结果）：这些对象下的字段来自端口记录，
   * 保存校验在该函数的参数里不按对象字段目录检查它们。
   */
  readonly recordObjects?: readonly string[];
  /**
   * 在待办中触发计算时，含该函数的计算项目不计算（面板原文，`26` §8.6；排名函数）。引擎只标记，调度由 R3-T04 落实。
   */
  readonly skipInTodoTrigger?: boolean;
  /**
   * 返回值类型（统一类型推导，DEC-287）：一种为确定类型，多种为“不确定、只可能是其中之一”（如 Sum 遇文本拼接，
   * 数值或文本）；取决于数据（取数字段、未知结构）时不写，推导为不确定。
   * 函数取不到值时返回的空值按它标来源类型（只有一种、或几种都不是日期时）。
   */
  readonly returns?: StaticKind | readonly StaticKind[];
  /** 返回值取这些参数的合并类型（IF 的两个分支，缺的分支不参与合并），见 typing.ts mergeTypes。 */
  readonly returnsFromArgs?: readonly number[];
  /**
   * 须是日期的参数下标（DEC-270②）：推导为确定的非日期时保存报错，不确定时保存提示（不阻断），
   * 计算时非日期值与非日期来源的空值计算失败。
   */
  readonly dateParams?: readonly number[];
  /** 函数自己的保存检查（参数下标之外的规则），按统一类型推导的结果判断。 */
  readonly checkArgs?: (args: readonly ExprNode[], infer: (node: ExprNode) => InferredType) => readonly ArgumentIssue[];
  readonly implement: (call: FunctionCall) => ExprValue;
}

export function arityOf(spec: FunctionSpec): { readonly min: number; readonly max: number } {
  const min = spec.params.filter((param) => param.required).length;
  const max = spec.params.some((param) => param.variadic) ? Number.POSITIVE_INFINITY : spec.params.length;
  return { min, max };
}

const normalize = (name: string) => name.toLowerCase();

export class FunctionRegistry {
  private readonly byName = new Map<string, FunctionSpec>();
  private readonly specs: FunctionSpec[] = [];

  register(spec: FunctionSpec): this {
    for (const name of [spec.name, ...spec.aliases]) {
      const key = normalize(name);
      const existing = this.byName.get(key);
      if (existing && existing !== spec) throw new Error(`函数名重复：${name}（已登记为 ${existing.name}）`);
      this.byName.set(key, spec);
    }
    this.specs.push(spec);
    return this;
  }

  resolve(name: string): FunctionSpec | undefined {
    return this.byName.get(normalize(name));
  }

  list(): readonly FunctionSpec[] {
    return [...this.specs];
  }
}

/** 内置函数库（`26` §8.6 面板全集 + 评定专用函数）；使用方在其上追加自定义函数。 */
export function createDefaultRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();
  for (const spec of BUILTIN_FUNCTIONS) registry.register(spec);
  return registry;
}
