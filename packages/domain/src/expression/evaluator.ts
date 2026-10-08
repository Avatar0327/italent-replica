/**
 * 求值器（REQ-EXP-001）：按语法树求值；字段先查记录作用域（取数函数过滤时），再查对象读取器；
 * 失败以 ComputationError 抛出并由 engine.ts 转成结构化结果。
 */
import type { CallNode, ExprNode, FieldNode, IdentifierNode, Program } from './ast.js';
import type { EvaluationContext } from './context.js';
import { instantToParts } from './dates.js';
import {
  ComputationError,
  CONVERSION_MESSAGE,
  fail,
  failMultiOption,
  hyphenHint,
  type FailureCode,
} from './failures.js';
import { arithmetic, compare, operandNumber, toCondition, toDate, toNumber, toText } from './operators.js';
import { plainToValue, type FieldLookup, type SubjectReader } from './ports.js';
import {
  arityOf,
  createDefaultRegistry,
  type FunctionCall,
  type FunctionEnvironment,
  type FunctionRegistry,
} from './registry.js';
import { DEFAULT_SEMANTICS, type ExpressionSemantics } from './semantics.js';
import { emptySource, NO_RECORDS, TypeInference, withRecordObjects } from './typing.js';
import {
  EMPTY,
  emptyOf,
  isMultiOptionField,
  KIND_LABELS,
  type DateParts,
  type ExprValue,
  type PlainValue,
} from './values.js';

/** 空日期参与日期函数时的取值（DEC-270：0001-01-01）。 */
const MIN_DATE: DateParts = Object.freeze({
  year: 1,
  month: 1,
  day: 1,
  hour: 0,
  minute: 0,
  second: 0,
  precision: 'date',
});

interface Scope {
  readonly vars: ReadonlyMap<string, ExprValue>;
  /** 取数函数过滤时叠加的记录字段（键为完整路径，如 考核结果.年度），内层优先。 */
  readonly records: readonly Readonly<Record<string, ExprValue>>[];
  /** 所在取数函数的记录对象名（如 考核结果）：类型推导把这些对象下的字段看作不确定，与保存检查同一范围。 */
  readonly objects: ReadonlySet<string>;
}

export class Evaluator {
  readonly registry: FunctionRegistry;
  readonly semantics: ExpressionSemantics;
  /**
   * 与保存检查同一套类型推导（DEC-287）：函数按它区分参数角色，空值按它标来源类型；排名成员的子求值器共用同一份 Def 类型。
   */
  private readonly typing: TypeInference;

  constructor(
    private readonly context: EvaluationContext,
    typing?: TypeInference,
  ) {
    this.registry = context.registry ?? createDefaultRegistry();
    this.semantics = context.semantics ?? DEFAULT_SEMANTICS;
    this.typing = typing ?? new TypeInference({ registry: this.registry, fieldKind: context.fieldKind });
  }

  run(program: Program): ExprValue {
    const vars = new Map<string, ExprValue>();
    const scope: Scope = { vars, records: [], objects: NO_RECORDS };
    for (const definition of program.definitions) {
      // 与保存检查同序（DEC-287①）：右侧按重新定义之前的类型求值，算完再登记新类型
      const value = this.evaluate(definition.value, scope);
      this.typing.define(definition.name, definition.value);
      vars.set(definition.name, value);
    }
    return this.evaluate(program.body, scope);
  }

  fromPlain(value: PlainValue): ExprValue {
    // DEC-314②：未提供目录时也不能把多选数组静默当空值（🟡 取证前禁止参与公式）。
    if (Array.isArray(value)) return failMultiOption();
    return plainToValue(value, (instant) => ({
      kind: 'date',
      value: instantToParts(instant, this.context.calendar.timeZone),
    }));
  }

  private evaluate(node: ExprNode, scope: Scope): ExprValue {
    const value = this.attachPosition(node, () => this.evaluateNode(node, scope));
    return value.kind === 'empty' && value.of === undefined ? this.sourced(value, node, scope) : value;
  }

  /**
   * 空值的来源类型取统一类型推导（DEC-287①），与保存检查同一结论：日期参数只把来源为日期或未知的空值按 0001-01-01，
   * 数值、文本等来源的空值计算失败（DEC-270②）。推导不出（可能是日期）时保持来源未知。
   */
  private sourced(value: ExprValue, node: ExprNode, scope: Scope): ExprValue {
    const source = emptySource(this.typing.infer(node, scope.objects));
    return source ? emptyOf(source) : value;
  }

  /** 失败原因没有位置时补上当前节点的位置（最内层节点优先）。 */
  private attachPosition<T>(node: ExprNode, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof ComputationError && error.failure.line === undefined) {
        throw new ComputationError({ ...error.failure, ...node.pos }, error.reason);
      }
      throw error;
    }
  }

  /** 四则运算的操作数：转换失败定位到操作数本身而不是运算符。 */
  private operand(node: ExprNode, scope: Scope): number | undefined {
    const value = this.evaluate(node, scope);
    return this.attachPosition(node, () => operandNumber(value, this.semantics, 'EMPTY_IN_ARITHMETIC'));
  }

  private evaluateNode(node: ExprNode, scope: Scope): ExprValue {
    switch (node.type) {
      case 'number':
        return {
          kind: 'number',
          value: node.percent && this.semantics.percentAsDecimal ? node.value / 100 : node.value,
        };
      case 'string':
        return { kind: 'text', value: node.value };
      case 'boolean':
        return { kind: 'boolean', value: node.value };
      case 'identifier':
        return this.resolveIdentifier(node, scope);
      case 'field':
        return this.resolveField(node, scope);
      case 'unary': {
        if (node.operator === '+') return this.evaluate(node.operand, scope);
        const value = this.operand(node.operand, scope);
        // 0 - value 而不是 -value：空值按 0 参与时（DEC-257）结果是 0 而不是 -0
        return value === undefined ? emptyOf('number') : { kind: 'number', value: 0 - value };
      }
      case 'binary': {
        if (node.operator === '+' || node.operator === '-' || node.operator === '*' || node.operator === '/') {
          const result = arithmetic(node.operator, this.operand(node.left, scope), this.operand(node.right, scope));
          return result.kind === 'empty' ? emptyOf('number') : result;
        }
        const left = this.evaluate(node.left, scope);
        const right = this.evaluate(node.right, scope);
        return { kind: 'boolean', value: compare(node.operator, left, right, this.semantics) };
      }
      case 'logical':
        return this.evaluateLogical(node, scope);
      case 'if':
        for (const branch of node.branches) {
          if (toCondition(this.evaluate(branch.condition, scope), this.semantics))
            return this.evaluate(branch.then, scope);
        }
        if (node.otherwise) return this.evaluate(node.otherwise, scope);
        // 都没命中且缺“否则”：多段 如果 等同逐层嵌套的“否则 如果”，空值来源取最后一段的类型
        return this.sourced(EMPTY, node.branches.at(-1)!.then, scope);
      case 'call':
        return this.call(node, scope);
    }
  }

  private evaluateLogical(node: Extract<ExprNode, { type: 'logical' }>, scope: Scope): ExprValue {
    const truthy = (child: ExprNode) => toCondition(this.evaluate(child, scope), this.semantics);
    if (node.operator === 'not') return { kind: 'boolean', value: !truthy(node.operand) };
    if (node.operator === 'and') return { kind: 'boolean', value: truthy(node.left) && truthy(node.right) };
    return { kind: 'boolean', value: truthy(node.left) || truthy(node.right) };
  }

  private resolveIdentifier(node: IdentifierNode, scope: Scope): ExprValue {
    const variable = scope.vars.get(node.name);
    if (variable) return variable;
    return this.lookup(node.name, scope);
  }

  private resolveField(node: FieldNode, scope: Scope): ExprValue {
    return this.lookup(node.text, scope);
  }

  private lookup(path: string, scope: Scope): ExprValue {
    if (!scope.objects.has(path.split('.')[0]!) && isMultiOptionField(this.context.fieldKind, path)) {
      return failMultiOption(path);
    }
    for (let i = scope.records.length - 1; i >= 0; i--) {
      const record = scope.records[i]!;
      if (Object.hasOwn(record, path)) return record[path]!;
    }
    const found = this.readSubjectField(path);
    if (found.status === 'computed') return found.value;
    if (found.status === 'found') {
      const value = this.fromPlain(found.value);
      // 批量求值里先算项目的空结果自带来源；其余空值的来源由 evaluate 按字段类型目录推导补上
      return value.kind === 'empty' && found.emptyOf ? emptyOf(found.emptyOf) : value;
    }
    if (found.status === 'forbidden') return fail('FIELD_FORBIDDEN', `当前查看人无权读取字段 ${path}`);
    return fail('UNKNOWN_FIELD', `找不到字段或变量 ${path}${hyphenHint(path)}`);
  }

  /** 对象读取器是使用方代码：抛出的异常转成不透出内容的失败原因（astra 首审 P2-5）。 */
  private readSubjectField(path: string): FieldLookup {
    try {
      return this.context.subject.resolveField(path);
    } catch {
      return fail('DATA_UNAVAILABLE', `读取字段 ${path} 时数据源出错`);
    }
  }

  private call(node: CallNode, scope: Scope): ExprValue {
    const spec = this.registry.resolve(node.name);
    if (!spec) return fail('UNKNOWN_FUNCTION', `未知函数 ${node.name}`);
    const { min, max } = arityOf(spec);
    if (node.args.length < min || node.args.length > max) {
      const expected =
        max === Number.POSITIVE_INFINITY ? `至少 ${min} 个` : min === max ? `${min} 个` : `${min}～${max} 个`;
      return fail('ARGUMENT_COUNT', `函数 ${node.name} 需要 ${expected}参数，实际 ${node.args.length} 个`);
    }
    // 参数里的记录对象范围与保存检查一致：外层范围加上本函数的记录对象
    const inner: Scope = { ...scope, objects: withRecordObjects(scope.objects, spec) };
    const args = spec.lazy ? [] : node.args.map((arg) => this.evaluate(arg, inner));
    // 取不到值时的空结果由 evaluate 按统一类型推导补上来源（声明的返回类型、IF 各分支的合并）
    return spec.implement(this.functionCall(node, args, inner));
  }

  /** scope 是参数的作用域（含本函数的记录对象）。 */
  private functionCall(node: CallNode, args: readonly ExprValue[], scope: Scope): FunctionCall {
    const semantics = this.semantics;
    const failAt = (code: FailureCode, detail: string): never => fail(code, detail, node.pos);
    return {
      node,
      args,
      rawArgs: node.args,
      evaluate: (child, recordFields) =>
        this.evaluate(child, recordFields ? { ...scope, records: [...scope.records, recordFields] } : scope),
      variable: (name) => scope.vars.get(name),
      evaluateForSubject: (child, subject) =>
        this.forSubject(subject).evaluate(child, { vars: scope.vars, records: [], objects: scope.objects }),
      fail: failAt,
      numberArg: (values, index) => {
        const value = values[index] ?? EMPTY;
        if (value.kind === 'empty') {
          // DEC-270：函数的数值参数遇空，原站“无法转换为double类型”；四则另按 emptyInArithmetic
          if (semantics.emptyInFunctionArgument === 'zero') return 0;
          return failAt('EMPTY_IN_ARITHMETIC', '空值参与函数计算（无法转换为数值）');
        }
        return (
          operandNumber(value, semantics, 'EMPTY_IN_ARITHMETIC') ?? failAt('EMPTY_IN_ARITHMETIC', '空值参与函数计算')
        );
      },
      dateArg: (values, index) => {
        const value = values[index] ?? EMPTY;
        if (value.kind !== 'empty') return toDate(value);
        // DEC-270②：只有真正的空日期（来源是日期或未知）按 0001-01-01；数值函数等非日期来源的空值计算失败
        if (value.of !== undefined && value.of !== 'date') {
          return failAt('TYPE_CONVERSION', `${CONVERSION_MESSAGE}（${KIND_LABELS[value.of]}的空值不能作为日期）`);
        }
        if (semantics.emptyDateArgument === 'min-date') return MIN_DATE;
        return toDate(value);
      },
      textArg: (values, index) => toText(values[index] ?? EMPTY),
      toNumber: (value) => toNumber(value, semantics),
      toText,
      toDate,
      toBoolean: (value) => toCondition(value, semantics),
      inferType: (child) => this.typing.infer(child, scope.objects),
      env: this.environment(),
    };
  }

  /** 以另一个对象为主体的求值器（排名范围成员），共用注册表、语义与端口。 */
  private forSubject(subject: SubjectReader): Evaluator {
    const context = { ...this.context, subject, registry: this.registry, semantics: this.semantics };
    return new Evaluator(context, this.typing);
  }

  private environment(): FunctionEnvironment {
    return {
      subjectId: this.context.subject.id,
      calendar: this.context.calendar,
      project: this.context.project,
      assessmentLatestWindow: this.context.assessmentLatestWindow ?? 'before_project_end',
      semantics: this.semantics,
      ports: this.context.ports,
      rankingTables: this.context.rankingTables,
      fromPlain: (value) => this.fromPlain(value),
    };
  }
}
