/**
 * 类型转换、比较与四则（`26` §8.2 / §8.3 / §8.5）。空值与四则的可调口径从 semantics.ts 读取（DEC-257）。
 */
import { dateOrdinal, parseDateText } from './dates.js';
import { CONVERSION_MESSAGE, fail, type FailureCode } from './failures.js';
import type { ExpressionSemantics } from './semantics.js';
import { describeValue, EMPTY, KIND_LABELS, formatIsoLike, type DateParts, type ExprValue } from './values.js';
import type { ArithmeticOperator, ComparisonOperator } from './ast.js';

const PERCENT = /^(-?\d+(?:\.\d+)?)%$/;

function numericText(raw: string, semantics: ExpressionSemantics): number | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  const percent = PERCENT.exec(value);
  if (percent) return semantics.percentAsDecimal ? Number(percent[1]) / 100 : Number(percent[1]);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** ToNumber(值) 函数的结果：空值按配置给 0 / 空 / 失败（DEC-257 默认 0），其余同 toNumber。 */
export function toNumberValue(value: ExprValue, semantics: ExpressionSemantics): ExprValue {
  if (value.kind === 'empty' && semantics.toNumberOfEmpty === 'empty') return EMPTY;
  return { kind: 'number', value: toNumber(value, semantics) };
}

/** ToNumber 语义：文本 / 百分比 / 是否 / 单选值可转，空值按配置，转不了报“转换出错”。 */
export function toNumber(value: ExprValue, semantics: ExpressionSemantics): number {
  switch (value.kind) {
    case 'number':
      return value.value;
    case 'empty':
      if (semantics.toNumberOfEmpty === 'zero') return 0;
      return fail('TYPE_CONVERSION', `${CONVERSION_MESSAGE}（空值无法转换为数值）`);
    case 'boolean':
      return value.value ? 1 : 0;
    case 'text':
    case 'option': {
      const parsed = typeof value.value === 'number' ? value.value : numericText(value.value, semantics);
      if (parsed !== undefined) return parsed;
      return fail('TYPE_CONVERSION', `${CONVERSION_MESSAGE}（${describeValue(value)} 不是数值）`);
    }
    case 'date':
      return fail('TYPE_CONVERSION', `${CONVERSION_MESSAGE}（日期不能转换为数值）`);
  }
}

export function toText(value: ExprValue): string {
  switch (value.kind) {
    case 'empty':
      return '';
    case 'number':
      return String(value.value);
    case 'text':
      return value.value;
    case 'boolean':
      return value.value ? '真' : '假';
    case 'date':
      return formatIsoLike(value.value);
    case 'option':
      return String(value.value);
  }
}

export function toDate(value: ExprValue): DateParts {
  if (value.kind === 'date') return value.value;
  const parsed = value.kind === 'text' ? parseDateText(value.value) : undefined;
  if (parsed) return parsed;
  return fail('TYPE_CONVERSION', `${CONVERSION_MESSAGE}（${describeValue(value)} 不是日期）`);
}

/** 条件判断：是否型直接用；空值按配置视为“否”（171640267）；其他类型报错。 */
export function toCondition(value: ExprValue, semantics: ExpressionSemantics): boolean {
  if (value.kind === 'boolean') return value.value;
  if (value.kind === 'empty') {
    if (semantics.emptyCondition === 'false') return false;
    return fail('EMPTY_IN_COMPARISON', '空值不能作为条件');
  }
  return fail('TYPE_CONVERSION', `条件须是是否型，实际是${KIND_LABELS[value.kind]}`);
}

/** 四则运算 / 聚合的操作数：数值与单选值可用；空值、文本按配置（DEC-257）；是否、日期失败。 */
export function operandNumber(
  value: ExprValue,
  semantics: ExpressionSemantics,
  emptyCode: Extract<FailureCode, 'EMPTY_IN_ARITHMETIC' | 'EMPTY_IN_AGGREGATE'>,
): number | undefined {
  switch (value.kind) {
    case 'number':
      return value.value;
    case 'option':
      return toNumber(value, semantics);
    case 'empty':
      if (emptyCode === 'EMPTY_IN_AGGREGATE' && semantics.emptyInAggregate === 'skip') return undefined;
      if (emptyCode === 'EMPTY_IN_ARITHMETIC' && semantics.emptyInArithmetic === 'zero') return 0;
      if (emptyCode === 'EMPTY_IN_ARITHMETIC' && semantics.emptyInArithmetic === 'empty') return undefined;
      return fail(emptyCode, emptyCode === 'EMPTY_IN_AGGREGATE' ? '空值参与求平均 / 求和' : '空值参与四则运算');
    case 'text': {
      // 数字字符串按数值（"5" + 1 = 6，`26` §8.5）；非数字文本仍按“字符串参与四则”失败
      const parsed = semantics.textInArithmetic === 'coerce' ? numericText(value.value, semantics) : undefined;
      if (parsed !== undefined) return parsed;
      return fail('TEXT_IN_ARITHMETIC', `字符串 ${describeValue(value)} 参与四则运算`);
    }
    case 'boolean':
      return fail('TYPE_CONVERSION', '是否型不能参与四则运算');
    case 'date':
      return fail('TYPE_CONVERSION', '日期不能直接参与四则运算，请用日期函数');
  }
}

/** 操作数已由求值器按 operandNumber 转换；undefined 表示“空值参与四则 → 结果为空”的语义配置。 */
export function arithmetic(operator: ArithmeticOperator, a: number | undefined, b: number | undefined): ExprValue {
  if (a === undefined || b === undefined) return EMPTY;
  switch (operator) {
    case '+':
      return { kind: 'number', value: a + b };
    case '-':
      return { kind: 'number', value: a - b };
    case '*':
      return { kind: 'number', value: a * b };
    case '/':
      if (b === 0) return fail('DIVISION_BY_ZERO', '除数为 0');
      return { kind: 'number', value: a / b };
  }
}

type Comparable =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'date'; value: number }
  | { kind: 'boolean'; value: boolean };

/** 单选先解包成选项值（`26` §8.3 按选项值比较）；两侧都解包后再决定按什么类型比较。 */
function unwrapOption(value: ExprValue): ExprValue {
  if (value.kind !== 'option') return value;
  return typeof value.value === 'number'
    ? { kind: 'number', value: value.value }
    : { kind: 'text', value: value.value };
}

/** 文本按配置尝试转数值（"2026" 与 2026 等价）；两侧都是日期格式文本、或对侧是日期时转成日期。 */
function comparable(plain: ExprValue, other: ExprValue, semantics: ExpressionSemantics): Comparable | undefined {
  if (plain.kind === 'text') {
    // 两侧都是原站日期格式的文本（"2020/1/31"、"2020/01/01 00:00:00"、"2020/01"）时按日期比较（`26` §8.3）
    if (other.kind === 'text' && parseDateText(other.value)) {
      const parsed = parseDateText(plain.value);
      if (parsed) return { kind: 'date', value: dateOrdinal(parsed) };
    }
    if (other.kind === 'number' && semantics.textNumberEquality === 'loose') {
      const parsed = numericText(plain.value, semantics);
      if (parsed !== undefined) return { kind: 'number', value: parsed };
    }
    if (other.kind === 'date') {
      const parsed = parseDateText(plain.value);
      return parsed ? { kind: 'date', value: dateOrdinal(parsed) } : undefined;
    }
    return plain;
  }
  if (plain.kind === 'date') return { kind: 'date', value: dateOrdinal(plain.value) };
  if (plain.kind === 'empty' || plain.kind === 'option') return undefined;
  return plain;
}

/**
 * 比较大小的操作数：数值、日期，以及能按日期解读的文本（两侧都是原站日期格式文本，或对侧是日期）。
 * 其余文本不转数值、不按字典序（DEC-257）；是否型不能比较大小。
 */
function orderable(plain: ExprValue, other: ExprValue): { kind: 'number' | 'date'; value: number } | undefined {
  if (plain.kind === 'number') return plain;
  if (plain.kind === 'date') return { kind: 'date', value: dateOrdinal(plain.value) };
  if (plain.kind !== 'text') return undefined;
  const otherIsDate = other.kind === 'date' || (other.kind === 'text' && parseDateText(other.value) !== undefined);
  const parsed = otherIsDate ? parseDateText(plain.value) : undefined;
  return parsed ? { kind: 'date', value: dateOrdinal(parsed) } : undefined;
}

export function valuesEqual(left: ExprValue, right: ExprValue, semantics: ExpressionSemantics): boolean {
  if (left.kind === 'empty' || right.kind === 'empty') {
    if (semantics.emptyInEquality === 'fail') return fail('EMPTY_IN_COMPARISON', '空值参与比较');
    return left.kind === 'empty' && right.kind === 'empty';
  }
  const [l, r] = [unwrapOption(left), unwrapOption(right)];
  const a = comparable(l, r, semantics);
  const b = comparable(r, l, semantics);
  if (!a || !b || a.kind !== b.kind) return false;
  return a.value === b.value;
}

export function compare(
  operator: ComparisonOperator,
  left: ExprValue,
  right: ExprValue,
  semantics: ExpressionSemantics,
): boolean {
  if (operator === '=') return valuesEqual(left, right, semantics);
  if (operator === '!=') return !valuesEqual(left, right, semantics);
  if (left.kind === 'empty' || right.kind === 'empty') {
    if (semantics.emptyInOrdering === 'false') return false;
    return fail('EMPTY_IN_COMPARISON', '空值参与大于 / 小于比较，请先用 ToNumber 转换');
  }
  const [l, r] = [unwrapOption(left), unwrapOption(right)];
  const a = orderable(l, r);
  const b = orderable(r, l);
  if (!a || !b || a.kind !== b.kind) {
    // 文本参与比较大小（"10" > "9"、"5" > 3）原站运行期报“比较【10>9】 时出错！”（`26` §8.5，DEC-257）
    if (l.kind === 'text' || r.kind === 'text') {
      return fail('TYPE_CONVERSION', `比较【${toText(l)}${operator}${toText(r)}】时出错`);
    }
    return fail('TYPE_CONVERSION', `${KIND_LABELS[left.kind]}与${KIND_LABELS[right.kind]}不能比较大小`);
  }
  const delta = a.value - b.value;
  switch (operator) {
    case '<':
      return delta < 0;
    case '>':
      return delta > 0;
    case '<=':
      return delta <= 0;
    case '>=':
      return delta >= 0;
  }
}
