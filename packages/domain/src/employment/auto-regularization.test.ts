import { describe, expect, it } from 'vitest';
import {
  autoRegularizationTargetDate,
  isAutoRegularizationDays,
  matchAutoRegularizationRule,
} from './auto-regularization.js';

describe('自动转正规则（PB-R18、R2e6 / R2e7）', () => {
  it('到期前天数只接受 0～999 的整数', () => {
    for (const value of [0, 1, 999]) expect(isAutoRegularizationDays(value)).toBe(true);
    for (const value of [-1, 1000, 1.5, null, undefined, '3', Number.NaN])
      expect(isAutoRegularizationDays(value)).toBe(false);
  });

  it('目标日 = 预计试用结束日 − N 天：到期当天、跨月、跨年', () => {
    expect(autoRegularizationTargetDate('2026-10-15', 0)).toBe('2026-10-15');
    expect(autoRegularizationTargetDate('2026-11-02', 3)).toBe('2026-10-30');
    expect(autoRegularizationTargetDate('2027-01-01', 1)).toBe('2026-12-31');
  });

  it('取第一条启用且适用组织含该部门的规则；停用、部门为空不命中', () => {
    const rules = [
      { id: 'off', enabled: false, scopeOrgIds: ['d1'] },
      { id: 'top', enabled: true, scopeOrgIds: ['d1', 'd2'] },
      { id: 'low', enabled: true, scopeOrgIds: ['d1', 'd3'] },
    ];
    expect(matchAutoRegularizationRule(rules, 'd1')?.id).toBe('top');
    expect(matchAutoRegularizationRule(rules, 'd3')?.id).toBe('low');
    expect(matchAutoRegularizationRule(rules, 'd4')).toBeNull();
    expect(matchAutoRegularizationRule(rules, null)).toBeNull();
  });
});
