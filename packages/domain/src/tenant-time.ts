/**
 * 租户时区（DEC-056；REQ-TEN-001 R5）：业务日期、生效日判定、“今天”一律按租户时区；
 * 事件时间以 UTC 瞬时（Date）传入。不使用运行环境或浏览器的本地时区。
 */

export const DEFAULT_TENANT_TIMEZONE = 'Asia/Shanghai';

/** ISO 业务日期 YYYY-MM-DD。 */
export type IsoDate = string;

// 只接受 IANA 名（UTC 或 Area/Location）；拒绝 “+08:00”“UTC+8” 这类偏移写法，它们不随夏令时等规则变化
const IANA_NAME = /^(UTC|[A-Z][A-Za-z_]*(\/[A-Za-z0-9_+-]+)+)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (!IANA_NAME.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`不是合法的 IANA 时区：${timeZone}`);
}

/** 某一瞬时在租户时区下的本地日期。 */
export function tenantLocalDate(instant: Date, timeZone: string): IsoDate {
  assertValidTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: 'year' | 'month' | 'day') => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** 生效日是否已到：生效日 <= 租户本地“今天”（硬规则 4：未来生效日由定时任务按此落地）。 */
export function isEffectiveDue(effectiveDate: IsoDate, timeZone: string, now: Date): boolean {
  assertIsoDate(effectiveDate);
  return effectiveDate <= tenantLocalDate(now, timeZone);
}

function assertIsoDate(value: string): void {
  const match = ISO_DATE.exec(value);
  const [year, month, day] = match ? match.slice(1).map(Number) : [];
  const date = match ? new Date(Date.UTC(year!, month! - 1, day!)) : undefined;
  if (!date || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`不是合法的业务日期（YYYY-MM-DD）：${value}`);
  }
}
