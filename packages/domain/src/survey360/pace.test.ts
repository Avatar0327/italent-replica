/**
 * 评价过快判定的纯规则（F-060 收尾，DEC-392）：平均单题耗时 < 1.5 秒算过快；边界 1.5 秒整不算；
 * 分母是全部可答题（调用方传入），没有题目时不判。
 */
import { describe, expect, it } from 'vitest';
import { FAST_ANSWER_MS_PER_ITEM, isTooFast } from './pace.js';

describe('F-060 评价过快判定（DEC-392）', () => {
  it('阈值是每题 1.5 秒（1500 毫秒）', () => {
    expect(FAST_ANSWER_MS_PER_ITEM).toBe(1500);
  });

  it('平均单题耗时严格小于阈值才算过快；恰好 1.5 秒 / 题不算', () => {
    expect(isTooFast(4499, 3)).toBe(true);
    expect(isTooFast(4500, 3)).toBe(false);
    expect(isTooFast(4501, 3)).toBe(false);
    expect(isTooFast(0, 3)).toBe(true);
    expect(isTooFast(1499, 1)).toBe(true);
    expect(isTooFast(1500, 1)).toBe(false);
  });

  it('分母是题目总数：同样的耗时，题目越多越容易算过快', () => {
    expect(isTooFast(12_000, 8)).toBe(false);
    expect(isTooFast(11_999, 8)).toBe(true);
  });

  it('没有题目不判；负数耗时（时钟回拨）按 0 处理', () => {
    expect(isTooFast(10_000, 0)).toBe(false);
    expect(isTooFast(-5, 3)).toBe(true);
  });
});
