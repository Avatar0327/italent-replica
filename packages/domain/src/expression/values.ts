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

/** 静态类型推导与空值来源用到的值类型（DEC-270 / DEC-287）。 */
export type StaticKind = 'number' | 'text' | 'boolean' | 'date';

/** 字段目录可标识多选；它不是可求值的标量类型（DEC-314②，🟡 取证前禁止引用）。 */
export type ExpressionFieldKind = StaticKind | 'multi_option';

export function isMultiOptionField(
  catalog: ((path: string) => ExpressionFieldKind | undefined) | undefined,
  path: string,
): boolean {
  try {
    return catalog?.(path) === 'multi_option';
  } catch {
    // 沿用 DEC-287：目录读取失败时类型不确定，不把异常内容带入保存结果。
    return false;
  }
}

export type ExprValue =
  | {
      readonly kind: 'empty';
      /**
       * 空值的来源类型：声明了返回类型的函数取不到值（如绩效得分 → number）、字段类型目录标明类型的字段为空。
       * 来源未知时不写。日期参数据此区分“真正的空日期”与数值函数的空结果（DEC-270②，PR #108 第 3 轮）。
       */
      readonly of?: StaticKind;
    }
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

const TYPED_EMPTY: Readonly<Record<StaticKind, ExprValue>> = Object.freeze({
  number: Object.freeze({ kind: 'empty', of: 'number' } as const),
  text: Object.freeze({ kind: 'empty', of: 'text' } as const),
  boolean: Object.freeze({ kind: 'empty', of: 'boolean' } as const),
  date: Object.freeze({ kind: 'empty', of: 'date' } as const),
});

/** 已知来源类型的空值。 */
export const emptyOf = (kind: StaticKind): ExprValue => TYPED_EMPTY[kind];

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
      return value.of ? `空值（${KIND_LABELS[value.of]}）` : '空值';
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
