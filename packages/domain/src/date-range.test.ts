import { describe, expect, it } from 'vitest';
import { rangesOverlap } from './date-range.js';

describe('rangesOverlap（左闭右开）', () => {
  it('首尾相接不算重叠', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: '2026-02-01' }, { start: '2026-02-01', end: null })).toBe(false);
  });

  it('有交集即重叠', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: '2026-03-01' }, { start: '2026-02-01', end: null })).toBe(true);
  });

  it('无上界区间与之后的任何区间重叠', () => {
    expect(rangesOverlap({ start: '2026-01-01', end: null }, { start: '2030-01-01', end: '2030-02-01' })).toBe(true);
  });
});
