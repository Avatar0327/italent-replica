import { describe, expect, it } from 'vitest';
import {
  assertValidTimeZone,
  DEFAULT_TENANT_TIMEZONE,
  isEffectiveDue,
  isValidTimeZone,
  tenantLocalDate,
} from './tenant-time.js';

// AC-TEN-05 的场景时刻：UTC 09-30 17:00 = 北京时间 10-01 01:00
const utcSep30At17 = new Date('2026-09-30T17:00:00Z');

describe('租户时区（DEC-056，REQ-TEN-001 R5）', () => {
  it('默认时区为 Asia/Shanghai', () => {
    expect(DEFAULT_TENANT_TIMEZONE).toBe('Asia/Shanghai');
  });

  it('同一时刻在不同租户时区下的本地日期不同（跨日边界）', () => {
    expect(tenantLocalDate(utcSep30At17, 'Asia/Shanghai')).toBe('2026-10-01');
    expect(tenantLocalDate(utcSep30At17, 'UTC')).toBe('2026-09-30');
  });

  it('本地零点前后一秒落在不同日期', () => {
    expect(tenantLocalDate(new Date('2026-09-30T15:59:59Z'), 'Asia/Shanghai')).toBe('2026-09-30');
    expect(tenantLocalDate(new Date('2026-09-30T16:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-01');
  });

  it('生效日 <= 租户本地今天才算到期', () => {
    expect(isEffectiveDue('2026-10-01', 'Asia/Shanghai', utcSep30At17)).toBe(true);
    expect(isEffectiveDue('2026-10-01', 'UTC', utcSep30At17)).toBe(false);
    expect(isEffectiveDue('2026-10-01', 'UTC', new Date('2026-10-01T00:00:00Z'))).toBe(true);
    expect(isEffectiveDue('2026-09-01', 'UTC', utcSep30At17)).toBe(true);
  });

  it('生效日格式不合法时报错，而不是按字符串比较蒙混过去', () => {
    expect(() => isEffectiveDue('2026-9-1', 'UTC', utcSep30At17)).toThrow(RangeError);
    expect(() => isEffectiveDue('2026-02-30', 'UTC', utcSep30At17)).toThrow(RangeError);
  });

  it('只接受 IANA 时区名', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('Etc/GMT+8')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+08:00')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(() => assertValidTimeZone('Mars/Olympus')).toThrow(RangeError);
  });

  it('非法时区不能用于日期判定', () => {
    expect(() => tenantLocalDate(utcSep30At17, 'Mars/Olympus')).toThrow(RangeError);
  });
});
