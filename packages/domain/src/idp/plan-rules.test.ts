import { describe, expect, it } from 'vitest';
import { addDays } from '../contracts/rules.js';
import { autoStartCutoff, currentStageName, periodsIntersect, stageDueDate } from './plan-rules.js';

const refs = { planStart: '2026-01-01', planEnd: '2026-12-31', previousEnd: '2026-09-01', employmentEffective: null };
const rule = {
  startMode: 'auto' as const,
  startTimeType: null,
  fixedDate: null,
  referencePoint: null,
  startFrom: null,
  days: null,
};

describe('IDP 计划执行规则', () => {
  it('到期日：无规则 / 固定 / 相对（前后 N 天、当天）/ 手动 / 参照日未知', () => {
    expect(stageDueDate(rule, 0, refs)).toBe('2026-01-01');
    expect(stageDueDate(rule, 1, refs)).toBe('2026-09-01');
    expect(stageDueDate({ ...rule, startTimeType: 'fixed', fixedDate: '2026-11-15' }, 1, refs)).toBe('2026-11-15');
    const relative = { ...rule, startTimeType: 'relative' as const, referencePoint: 'previous_end' as const };
    expect(stageDueDate({ ...relative, startFrom: 'after', days: 7 }, 1, refs)).toBe('2026-09-08');
    expect(stageDueDate({ ...relative, referencePoint: 'plan_end', startFrom: 'before', days: 5 }, 1, refs)).toBe(
      '2026-12-26',
    );
    expect(stageDueDate({ ...relative, startFrom: 'same_day' }, 1, refs)).toBe('2026-09-01');
    expect(stageDueDate({ ...relative, referencePoint: 'employment_effective', startFrom: 'same_day' }, 1, refs)).toBe(
      null,
    );
    expect(stageDueDate({ ...rule, startMode: 'manual' }, 1, refs)).toBe(null);
  });

  it('凌晨 2 点截止：2 点前只能开启昨天及以前到期的', () => {
    expect(autoStartCutoff({ date: '2026-09-08', hour: 1 })).toBe('2026-09-07');
    expect(autoStartCutoff({ date: '2026-09-08', hour: 2 })).toBe('2026-09-08');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('交集与当前阶段显示', () => {
    const plan = { startDate: '2026-01-01', endDate: '2026-12-31' };
    expect(periodsIntersect(plan, { startDate: '2025-10-01', endDate: '2026-03-31' })).toBe(true);
    expect(periodsIntersect(plan, { startDate: '2024-01-01', endDate: '2024-06-30' })).toBe(false);
    expect(periodsIntersect(plan, { startDate: '2025-01-01', endDate: null })).toBe(true);
    const stages = [
      { name: '制定计划', status: 'ended' as const },
      { name: '中期回顾', status: 'pending' as const },
    ];
    expect(currentStageName('running', stages)).toBe('努力提升中');
    expect(currentStageName('running', [{ name: '制定计划', status: 'running' }])).toBe('制定计划');
    expect(currentStageName('ended', stages)).toBe(null);
  });
});
