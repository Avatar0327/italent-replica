/**
 * 日期工具（`26` §8.3；DEC-056）：日期字面量解析、瞬时按租户时区转墙上时间、.NET 风格格式化、日期差与加减。
 * 业务日与“现在”按租户时区（DEC-056 / DEC-265，Q-M0-83 实算）。
 */
import type { DateParts, DatePrecision } from './values.js';

const DATE_TIME = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;
const YEAR_MONTH = /^(\d{4})[/-](\d{1,2})$/;
const TIME_ONLY = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;

export function makeDateParts(fields: Partial<DateParts> & { year: number; month: number; day: number }): DateParts {
  return {
    hour: 0,
    minute: 0,
    second: 0,
    precision: 'date',
    ...fields,
  };
}

/**
 * 墙上时间 → 毫秒序数。Date.UTC 会把 0～99 年当成 1900～1999 年，空日期按 0001-01-01 参与运算（DEC-270）
 * 时会算错，所以用 setUTCFullYear。
 */
export function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const instant = new Date(Date.UTC(2000, 0, 1, hour, minute, second));
  instant.setUTCFullYear(year, month - 1, day);
  return instant.getTime();
}

function isValidDate(year: number, month: number, day: number): boolean {
  const probe = new Date(utcMs(year, month, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** 支持 "2020/01/01"、"2020/01/01 00:00:00"、"2020/01/01 00:00"、"2020/01"、"00:00"，以及对应的 "-" 写法。 */
export function parseDateText(raw: string): DateParts | undefined {
  const value = raw.trim();
  const full = DATE_TIME.exec(value);
  if (full) {
    const [year, month, day] = [Number(full[1]), Number(full[2]), Number(full[3])];
    if (!isValidDate(year, month, day)) return undefined;
    const precision: DatePrecision = full[4] === undefined ? 'date' : 'datetime';
    const [hour, minute, second] = [Number(full[4] ?? 0), Number(full[5] ?? 0), Number(full[6] ?? 0)];
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    return { year, month, day, hour, minute, second, precision };
  }
  const month = YEAR_MONTH.exec(value);
  if (month) {
    const [year, mon] = [Number(month[1]), Number(month[2])];
    return isValidDate(year, mon, 1) ? makeDateParts({ year, month: mon, day: 1, precision: 'month' }) : undefined;
  }
  const time = TIME_ONLY.exec(value);
  if (time) {
    const [hour, minute, second] = [Number(time[1]), Number(time[2]), Number(time[3] ?? 0)];
    if (hour > 23 || minute > 59 || second > 59) return undefined;
    return { year: 1, month: 1, day: 1, hour, minute, second, precision: 'time' };
  }
  return undefined;
}

/** UTC 瞬时 → 租户时区下的墙上时间（DEC-056）。 */
export function instantToParts(instant: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
    precision: 'datetime',
  };
}

/** 可比较的序数：按墙上时间排序（不涉及时区换算）。 */
export function dateOrdinal(parts: DateParts): number {
  return utcMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

function fromOrdinal(ordinal: number, precision: DatePrecision): DateParts {
  const d = new Date(ordinal);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    precision,
  };
}

export type DateUnit = 'd' | 'm' | 'y';

export function parseDateUnit(raw: string): DateUnit | undefined {
  const unit = raw.trim().toLowerCase();
  if (unit === 'd' || unit === 'day' || unit === '日' || unit === '天') return 'd';
  if (unit === 'm' || unit === 'month' || unit === '月') return 'm';
  if (unit === 'y' || unit === 'year' || unit === '年') return 'y';
  return undefined;
}

const DAY_MS = 86_400_000;

/** 整数差：天按自然日，月 / 年按“满一个月 / 年”计（同 .NET 常见写法，🟡）。 */
export function dateDiff(unit: DateUnit, from: DateParts, to: DateParts): number {
  if (unit === 'd') {
    const start = utcMs(from.year, from.month, from.day);
    const end = utcMs(to.year, to.month, to.day);
    return Math.round((end - start) / DAY_MS);
  }
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (dateOrdinal({ ...to, year: from.year, month: from.month }) < dateOrdinal(from)) months--;
  return unit === 'm' ? months : Math.trunc(months / 12);
}

/** 加减分钟（AddHours / AddMinutes）：结果带时分，日期精度的值变为日期时间。 */
export function addMinutes(base: DateParts, minutes: number): DateParts {
  return fromOrdinal(dateOrdinal(base) + minutes * 60_000, base.precision === 'time' ? 'time' : 'datetime');
}

/** 加减：月 / 年加减后超出目标月天数时取该月最后一天（2020/01/31 + 1 月 = 2020/02/29）。 */
export function dateAdd(unit: DateUnit, amount: number, base: DateParts): DateParts {
  if (unit === 'd') return fromOrdinal(dateOrdinal(base) + amount * DAY_MS, base.precision);
  const totalMonths = base.year * 12 + (base.month - 1) + (unit === 'm' ? amount : amount * 12);
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12 + 1;
  const lastDay = new Date(utcMs(year, month + 1, 0)).getUTCDate();
  return { ...base, year, month, day: Math.min(base.day, lastDay) };
}

/** .NET 风格格式符：yyyy yy MM M dd d HH H hh h mm m ss s tt t；单引号内为字面量。 */
export function formatDate(parts: DateParts, pattern: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const meridiem = parts.hour < 12 ? 'AM' : 'PM';
  const specifiers: Readonly<Record<string, string>> = {
    yyyy: pad(parts.year, 4),
    yy: pad(parts.year % 100),
    MM: pad(parts.month),
    M: String(parts.month),
    dd: pad(parts.day),
    d: String(parts.day),
    HH: pad(parts.hour),
    H: String(parts.hour),
    hh: pad(hour12),
    h: String(hour12),
    mm: pad(parts.minute),
    m: String(parts.minute),
    ss: pad(parts.second),
    s: String(parts.second),
    tt: meridiem,
    t: meridiem[0]!,
  };
  return pattern.replace(
    /'([^']*)'|yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|tt|t/g,
    (match, literal: string | undefined) => (literal !== undefined ? literal : (specifiers[match] ?? match)),
  );
}
