import { describe, expect, it } from 'vitest';
import { referencedProcessChangeViolation, type StartRule, startRuleText, startRuleViolation } from './rules.js';

const auto = (extra: Partial<StartRule> = {}): StartRule => ({
  startMode: 'auto',
  startTimeType: null,
  fixedDate: null,
  referencePoint: null,
  startFrom: null,
  days: null,
  ...extra,
});

describe('IDP 子流程开启规则（Q-M0-115②）', () => {
  it('说明文本与原站样本一致', () => {
    expect(startRuleText(auto(), 1)).toBe('上一流程结束后自动开启');
    expect(startRuleText(auto(), 0)).toBe('发展计划开始后自动开启');
    expect(
      startRuleText(auto({ startTimeType: 'relative', referencePoint: 'plan_end', startFrom: 'before', days: 5 }), 2),
    ).toBe('于发展计划结束时间前5天的凌晨2点自动开启');
    expect(
      startRuleText(auto({ startTimeType: 'relative', referencePoint: 'plan_start', startFrom: 'same_day' }), 1),
    ).toBe('于发展计划开始时间当天的凌晨2点自动开启');
    expect(startRuleText(auto({ startTimeType: 'fixed', fixedDate: '2026-12-01' }), 1)).toBe(
      '于2026-12-01的凌晨2点自动开启',
    );
    expect(startRuleText({ ...auto(), startMode: 'manual' }, 1)).toBe('手动开启');
  });

  it('规则自洽性', () => {
    expect(startRuleViolation(auto(), 0)).toBeNull();
    expect(startRuleViolation(auto({ startTimeType: 'fixed' }), 1)).not.toBeNull();
    expect(
      startRuleViolation(auto({ startTimeType: 'relative', referencePoint: 'previous_end', startFrom: 'same_day' }), 0),
    ).not.toBeNull();
    expect(
      startRuleViolation(
        auto({ startTimeType: 'relative', referencePoint: 'previous_end', startFrom: 'after', days: 7 }),
        1,
      ),
    ).toBeNull();
    expect(
      startRuleViolation(
        auto({ startTimeType: 'relative', referencePoint: 'plan_end', startFrom: 'after', days: 0 }),
        1,
      ),
    ).not.toBeNull();
    expect(startRuleViolation({ ...auto({ fixedDate: '2026-01-01' }), startMode: 'manual' }, 1)).not.toBeNull();
  });
});

describe('IDP-R5 被引用流程的变更判定', () => {
  const before = [
    { id: 'a', startMode: 'auto' as const },
    { id: 'b', startMode: 'manual' as const },
  ];
  it('顺序、增删、开启方式变化都拒绝；其他不拒绝', () => {
    expect(referencedProcessChangeViolation(before, [...before].reverse())).not.toBeNull();
    expect(referencedProcessChangeViolation(before, before.slice(0, 1))).not.toBeNull();
    expect(referencedProcessChangeViolation(before, [...before, { startMode: 'auto' }])).not.toBeNull();
    expect(referencedProcessChangeViolation(before, [before[0]!, { id: 'b', startMode: 'auto' }])).not.toBeNull();
    expect(referencedProcessChangeViolation(before, before)).toBeNull();
  });
});
