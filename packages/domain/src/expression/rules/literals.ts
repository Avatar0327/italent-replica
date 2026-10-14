/**
 * 条件行字面量发码（R3-T05 设计 §3.2 “字面量”行）。引擎词法没有字符串转义（`lexer.ts` scanString），
 * 所以值里出现双引号或换行时只能拒绝，不能转义；所有校验失败都只返回类别，不回显值。
 */
import { formatIsoLike } from '../values.js';
import { parseDateText } from '../dates.js';
import type { RuleFieldKind, RuleFieldRef } from './types.js';

export type LiteralFailure = 'VALUE_TYPE' | 'LITERAL_INVALID' | 'OPTION_UNKNOWN';
export type LiteralResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly failure: LiteralFailure };

const ok = (text: string): LiteralResult => ({ ok: true, text });
const fail = (failure: LiteralFailure): LiteralResult => ({ ok: false, failure });

/** 多选值的无损编码分隔符（设计 §3.1）；值内含它会让 `|a|` 边界匹配失真。 */
const MULTI_DELIMITER = '|';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const EXPONENT_FORM = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/;

/**
 * 十进制文本，绝不出现科学计数法（引擎词法不认）。`String(value)` 是能还原该 double 的最短表示，
 * 带指数时把有效数字和指数**精确展开**（只挪小数点、补零，不舍入），所以引擎 `Number(文本)` 读回的就是原值；
 * 不能用 `toLocaleString` 之类的格式化——它按小数位数舍入，会让同值比较和阈值比较结果翻转。
 */
export function formatNumberLiteral(value: number): string {
  const text = String(value);
  const parts = EXPONENT_FORM.exec(text);
  if (!parts) return text;
  const [, sign, whole, fraction = '', exponent] = parts;
  const digits = `${whole}${fraction}`;
  const pointAt = whole!.length + Number(exponent);
  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

const quote = (value: string): LiteralResult => (/["\r\n]/.test(value) ? fail('LITERAL_INVALID') : ok(`"${value}"`));

function dateLiteral(value: unknown): LiteralResult {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return fail('VALUE_TYPE');
  // 往返比对挡住 2025-02-30 这类不存在的日历日
  const parts = parseDateText(value);
  return parts && formatIsoLike(parts) === value ? ok(`"${value}"`) : fail('VALUE_TYPE');
}

function optionLiteral(value: unknown, domain: RuleFieldRef['optionDomain']): LiteralResult {
  if (typeof value !== 'string') return fail('VALUE_TYPE');
  const quoted = quote(value);
  if (!quoted.ok) return quoted;
  // 选项域按 T04 字段描述；已停用的选项仍可编译，否则历史规则无法重新编译（设计 §3.1）
  return domain && !domain.some((entry) => entry.value === value) ? fail('OPTION_UNKNOWN') : quoted;
}

function multiOptionLiteral(value: unknown): LiteralResult {
  if (typeof value !== 'string') return fail('VALUE_TYPE');
  if (value === '' || value.includes(MULTI_DELIMITER)) return fail('LITERAL_INVALID');
  return quote(`${MULTI_DELIMITER}${value}${MULTI_DELIMITER}`);
}

/** aggregate 行的度量值恒为 number，其余按字段类型。 */
export function literalFor(kind: RuleFieldKind, value: unknown, field?: RuleFieldRef): LiteralResult {
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? ok(formatNumberLiteral(value)) : fail('VALUE_TYPE');
    case 'text':
      return typeof value === 'string' ? quote(value) : fail('VALUE_TYPE');
    case 'option':
      return optionLiteral(value, field?.optionDomain);
    case 'multi_option':
      return multiOptionLiteral(value);
    case 'date':
      return dateLiteral(value);
    case 'boolean':
      return typeof value === 'boolean' ? ok(String(value)) : fail('VALUE_TYPE');
  }
}
