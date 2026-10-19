/**
 * R2 BE-5c1a（R2-T04 §9.1，AC-RT-15 纯函数部分；DEC-638 A-4）：
 * 预计退休日期 = 出生日期 + 年龄（年月合并成总月数），再取目标月月末；出生日期为空或无命中 → 空。
 */
import { describe, expect, it } from 'vitest';
import { expectedDateOf } from '../../packages/domain/src/employment/retirement-rules.js';

describe('AC-RT-15 预计退休日期计算（纯函数，A-4）', () => {
  it.each([
    ['1965-03-15', 60, 0, '2025-03-31'],
    ['1970-01-31', 55, 1, '2025-02-28'],
    ['1970-11-10', 50, 3, '2021-02-28'],
    ['1990-12-20', 0, 11, '1991-11-30'],
    ['1963-05-01', 60, 6, '2023-11-30'],
    ['1965-12-31', 60, 0, '2025-12-31'],
  ])('出生 %s + %i 年 %i 个月 → 月末 %s', (birthday, years, months, expected) => {
    expect(expectedDateOf(birthday, years, months)).toBe(expected);
  });

  it('生日为 2 月 29 日：目标月是平年取 2-28，闰年取 2-29（A-4 月末口径）', () => {
    expect(expectedDateOf('1964-02-29', 61, 0)).toBe('2025-02-28');
    expect(expectedDateOf('1960-02-29', 60, 0)).toBe('2020-02-29');
    expect(expectedDateOf('1960-02-29', 61, 0)).toBe('2021-02-28');
  });

  it('出生日期为空或不是合法日期 → 空', () => {
    expect(expectedDateOf(null, 60, 0)).toBeNull();
    expect(expectedDateOf('', 60, 0)).toBeNull();
    expect(expectedDateOf('1965-02-30', 60, 0)).toBeNull();
    expect(expectedDateOf('not-a-date', 60, 0)).toBeNull();
  });
});
