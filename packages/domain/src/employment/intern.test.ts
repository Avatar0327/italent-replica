import { describe, expect, it } from 'vitest';
import { INTERN_VIEWS, PROBATION_MONTH_OPTIONS, probationExpectedEnd } from './intern.js';

describe('BE-6a 实习生纯函数', () => {
  it('预计试用结束日 = 开始 + 月数 − 1 天（R2f B41：10-16 + 1 个月 = 11-15）', () => {
    expect(probationExpectedEnd('2026-10-16', 1)).toBe('2026-11-15');
    expect(probationExpectedEnd('2026-10-01', 6)).toBe('2027-03-31');
    // 目标月没有该日时取月末再减一天（与合同期限 termEnd 同一口径）
    expect(probationExpectedEnd('2026-01-31', 1)).toBe('2026-02-27');
  });

  it('试用期月数选项 1～6；四视图编码固定', () => {
    expect(PROBATION_MONTH_OPTIONS).toEqual([1, 2, 3, 4, 5, 6]);
    expect(INTERN_VIEWS).toEqual(['interning', 'converting', 'converted', 'left']);
  });
});
