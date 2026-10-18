import { describe, expect, it } from 'vitest';
import { ASSESSMENT_OPINION_CODES, ASSESSMENT_STATUSES, type AssessmentStatus } from './assessment.js';
import {
  assessmentBlocksAutoRegularization,
  autoAssessmentTargetDate,
  matchAutoAssessmentRule,
  isAutoAssessmentDays,
} from './auto-assessment.js';

describe('自动发起考核（PB-R17、R2e6）', () => {
  it('入职后天数只接受 1～999 的整数，0 与空值不行', () => {
    for (const value of [1, 30, 999]) expect(isAutoAssessmentDays(value)).toBe(true);
    for (const value of [0, -1, 1000, 1.5, null, undefined, '3', Number.NaN])
      expect(isAutoAssessmentDays(value)).toBe(false);
  });

  it('目标日 = 入职日 + N 天：跨月、跨年', () => {
    expect(autoAssessmentTargetDate('2026-09-01', 30)).toBe('2026-10-01');
    expect(autoAssessmentTargetDate('2026-12-20', 15)).toBe('2027-01-04');
  });
});

describe('命中规则（AC-PB-06、AC-PB-11）', () => {
  const rule = (id: string, daysAfterEntry: number, enabled = true) => ({
    id,
    enabled,
    daysAfterEntry,
    scopeOrgIds: ['dept'],
  });
  const rules = [rule('a', 29), rule('b', 30, false), rule('c', 30), rule('d', 31)];

  it('只命中“今天是第 N 天”的启用规则，已过 / 未到的不命中，停用的跳过', () => {
    expect(matchAutoAssessmentRule(rules, 'dept', '2026-09-01', '2026-10-01')?.id).toBe('c');
    expect(matchAutoAssessmentRule(rules, 'dept', '2026-09-01', '2026-10-02')?.id).toBe('d');
    expect(matchAutoAssessmentRule(rules, 'dept', '2026-09-01', '2026-10-05')).toBeNull();
  });

  it('不在适用组织或没有主职部门不命中', () => {
    expect(matchAutoAssessmentRule(rules, 'other', '2026-09-01', '2026-10-01')).toBeNull();
    expect(matchAutoAssessmentRule(rules, null, '2026-09-01', '2026-10-01')).toBeNull();
  });
});

describe('PB-R21 考核类失败条件', () => {
  const statuses = Object.keys(ASSESSMENT_STATUSES) as AssessmentStatus[];

  it('转正考核：只有“审批通过且意见 = 正常转正”不阻断', () => {
    for (const status of statuses)
      for (const opinion of [...ASSESSMENT_OPINION_CODES, null])
        expect(assessmentBlocksAutoRegularization({ type: 'regularization', status, opinion })).toBe(
          !(status === 'approved' && opinion === 'normal'),
        );
  });

  it('试用中考核：审批中，或审批通过且意见 = 提前转正才阻断', () => {
    for (const status of statuses)
      for (const opinion of [...ASSESSMENT_OPINION_CODES, null])
        expect(assessmentBlocksAutoRegularization({ type: 'probation', status, opinion })).toBe(
          status === 'in_review' || (status === 'approved' && opinion === 'early'),
        );
  });
});
