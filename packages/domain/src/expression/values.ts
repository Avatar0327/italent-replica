/**
 * 表达式引擎的值模型（REQ-EXP-001，`26` §8.2 / §8.3）：数值、文本、日期、是否、单选、空值。
 * 日期一律是租户时区下的“墙上时间”（DEC-056），瞬时（Date）在进入引擎时按上下文时区转换。
 */

export type DatePrecision = 'date' | 'datetime' | 'month' | 'time';

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 字面量写法的精度（"2020/01" 为 month，"00:00" 为 time），只影响格式化与说明。 */
  readonly precision: DatePrecision;
}

export type ExprValue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'date'; readonly value: DateParts }
  | { readonly kind: 'option'; readonly value: string | number; readonly label?: string };

export type ExprValueKind = ExprValue['kind'];

/** 单选字段的外部表示：按选项值比较和赋值，显示文本只随行携带（`26` §8.3）。 */
export interface OptionValue {
  readonly optionValue: string | number;
  readonly label?: string;
}

/** 端口与使用方传入的普通 JS 值；Date 视为 UTC 瞬时。 */
export type PlainValue = number | string | boolean | Date | OptionValue | null | undefined;

export const EMPTY: ExprValue = Object.freeze({ kind: 'empty' } as const);

export const number = (value: number): ExprValue => ({ kind: 'number', value });
export const text = (value: string): ExprValue => ({ kind: 'text', value });
export const boolean = (value: boolean): ExprValue => ({ kind: 'boolean', value });
export const date = (value: DateParts): ExprValue => ({ kind: 'date', value });
export const option = (value: string | number, label?: string): ExprValue =>
  label === undefined ? { kind: 'option', value } : { kind: 'option', value, label };

export function isOptionValue(value: unknown): value is OptionValue {
  return typeof value === 'object' && value !== null && 'optionValue' in value;
}

export function isEmpty(value: ExprValue): boolean {
  return value.kind === 'empty';
}

export const KIND_LABELS: Readonly<Record<ExprValueKind, string>> = {
  empty: '空值',
  number: '数值',
  text: '文本',
  boolean: '是否',
  date: '日期',
  option: '单选',
};

/** 用户可读的值描述，只用于说明文案，不用于比较。 */
export function describeValue(value: ExprValue): string {
  switch (value.kind) {
    case 'empty':
      return '空值';
    case 'number':
      return String(value.value);
    case 'text':
      return `"${value.value}"`;
    case 'boolean':
      return value.value ? '真' : '假';
    case 'date':
      return formatIsoLike(value.value);
    case 'option':
      return value.label === undefined ? String(value.value) : `${value.label}(${value.value})`;
  }
}

export function formatIsoLike(parts: DateParts): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const day = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  if (parts.precision === 'date') return day;
  if (parts.precision === 'month') return day.slice(0, 7);
  const time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return parts.precision === 'time' ? time : `${day} ${time}`;
}
