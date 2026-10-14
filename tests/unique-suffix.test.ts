import { describe, expect, it } from 'vitest';
import { MIN_SUFFIX_LENGTH, uniqueSuffix } from './acceptance/support/unique.js';

describe('F-122 uniqueSuffix', () => {
  it('默认 12 位小写十六进制，可按字段上限加长', () => {
    expect(uniqueSuffix()).toMatch(/^[0-9a-f]{12}$/);
    expect(uniqueSuffix(20)).toMatch(/^[0-9a-f]{20}$/);
    expect(uniqueSuffix(40)).toHaveLength(40);
  });

  it('短于 12 位直接报错，避免重新引入短后缀', () => {
    expect(() => uniqueSuffix(MIN_SUFFIX_LENGTH - 1)).toThrow(RangeError);
    expect(() => uniqueSuffix(6)).toThrow(RangeError);
    expect(() => uniqueSuffix(12.5)).toThrow(RangeError);
  });

  it('连续生成 20000 个互不相同', () => {
    const seen = new Set(Array.from({ length: 20000 }, () => uniqueSuffix()));
    expect(seen.size).toBe(20000);
  });
});
