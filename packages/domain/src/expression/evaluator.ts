/**
 * 求值器（REQ-EXP-001）：按语法树求值；字段先查记录作用域（取数函数过滤时），再查对象读取器；
 * 失败以 ComputationError 抛出并由 engine.ts 转成结构化结果。
 */
import type { CallNode, ExprNode, FieldNode, IdentifierNode, Program } from './ast.js';
import type { EvaluationContext } from './context.js';
import { instantToParts } from './dates.js';
import { ComputationError, fail, type FailureCode } from './failures.js';
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
import { EMPTY, type ExprValue, type PlainValue } from './values.js';

interface Scope {
  readonly vars: ReadonlyMap<string, ExprValue>;
  /** 取数函数过滤时叠加的记录字段（键为完整路径，如 考核结果.年度），内层优先。 */
  readonly records: readonly Readonly<Record<string, ExprValue>>[];
}

export class Evaluator {
  readonly registry: FunctionRegistry;
  readonly semantics: ExpressionSemantics;

  constructor(private readonly context: EvaluationContext) {
    this.registry = context.registry ?? createDefaultRegistry();
    this.semantics = context.semantics ?? DEFAULT_SEMANTICS;
  }

  run(program: Program): ExprValue {
    const vars = new Map<string, ExprValue>();
    for (const definition of program.definitions) {
      vars.set(definition.name, this.evaluate(definition.value, { vars, records: [] }));
    }
    return this.evaluate(program.body, { vars, records: [] });
  }

  fromPlain(value: PlainValue): ExprValue {
    return plainToValue(value, (instant) => ({
      kind: 'date',
      value: instantToParts(instant, this.context.calendar.timeZone),
    }));
  }

  private evaluate(node: ExprNode, scope: Scope): ExprValue {
    return this.attachPosition(node, () => this.evaluateNode(node, scope));
  }

  /** 失败原因没有位置时补上当前节点的位置（最内层节点优先）。 */
  private attachPosition<T>(node: ExprNode, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof ComputationError && error.failure.line === undefined) {
        throw new ComputationError({ ...error.failure, ...node.pos });
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
        return value === undefined ? EMPTY : { kind: 'number', value: -value };
      }
      case 'binary': {
        if (node.operator === '+' || node.operator === '-' || node.operator === '*' || node.operator === '/') {
          return arithmetic(node.operator, this.operand(node.left, scope), this.operand(node.right, scope));
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
        return node.otherwise ? this.evaluate(node.otherwise, scope) : EMPTY;
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
    for (let i = scope.records.length - 1; i >= 0; i--) {
      const record = scope.records[i]!;
      if (Object.hasOwn(record, path)) return record[path]!;
    }
    const found = this.readSubjectField(path);
    if (found.status === 'found') return this.fromPlain(found.value);
    if (found.status === 'forbidden') return fail('FIELD_FORBIDDEN', `当前查看人无权读取字段 ${path}`);
    const hint = path.includes('-') ? '（字段名含“-”；如果是减法，请在“-”两侧加空格）' : '';
    return fail('UNKNOWN_FIELD', `找不到字段或变量 ${path}${hint}`);
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
    const args = spec.lazy ? [] : node.args.map((arg) => this.evaluate(arg, scope));
    return spec.implement(this.functionCall(node, args, scope));
  }

  private functionCall(node: CallNode, args: readonly ExprValue[], scope: Scope): FunctionCall {
    const semantics = this.semantics;
    const failAt = (code: FailureCode, detail: string): never => fail(code, detail, node.pos);
    return {
      node,
      args,
      rawArgs: node.args,
      evaluate: (child, recordFields) =>
        this.evaluate(child, recordFields ? { ...scope, records: [...scope.records, recordFields] } : scope),
      evaluateForSubject: (child, subject) =>
        this.forSubject(subject).evaluate(child, { vars: scope.vars, records: [] }),
      fail: failAt,
      numberArg: (values, index) =>
        operandNumber(values[index] ?? EMPTY, semantics, 'EMPTY_IN_ARITHMETIC') ??
        failAt('EMPTY_IN_ARITHMETIC', '空值参与函数计算'),
      textArg: (values, index) => toText(values[index] ?? EMPTY),
      toNumber: (value) => toNumber(value, semantics),
      toText,
      toDate,
      toBoolean: (value) => toCondition(value, semantics),
      env: this.environment(),
    };
  }

  /** 以另一个对象为主体的求值器（排名范围成员），共用注册表、语义与端口。 */
  private forSubject(subject: SubjectReader): Evaluator {
    return new Evaluator({ ...this.context, subject, registry: this.registry, semantics: this.semantics });
  }

  private environment(): FunctionEnvironment {
    return {
      subjectId: this.context.subject.id,
      calendar: this.context.calendar,
      project: this.context.project,
      assessmentLatestWindow: this.context.assessmentLatestWindow ?? 'before_project_end',
      semantics: this.semantics,
      ports: this.context.ports,
      fromPlain: (value) => this.fromPlain(value),
    };
  }
}
