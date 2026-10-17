import { describe, expect, it } from 'vitest';
import {
  actualProbationEndDate,
  defaultRegularizationDate,
  expectedProbationEndDate,
  normalizeProbationInfo,
  probationAdjustmentViolation,
} from './probation.js';

describe('试用期日期（R2e6 / R2f1，F-205）', () => {
  it('预计试用结束日 = 开始日 + 月数 − 1 天', () => {
    expect(expectedProbationEndDate('2026-10-16', 1)).toBe('2026-11-15');
    expect(expectedProbationEndDate('2026-09-01', 3)).toBe('2026-11-30');
    expect(expectedProbationEndDate('2026-08-01', 6)).toBe('2027-01-31');
  });

  it('默认转正日期 = 预计试用结束日的次日：月中、跨月、跨年、闰年', () => {
    expect(defaultRegularizationDate('2026-11-15')).toBe('2026-11-16');
    expect(defaultRegularizationDate('2026-11-30')).toBe('2026-12-01');
    expect(defaultRegularizationDate('2026-12-31')).toBe('2027-01-01');
    expect(defaultRegularizationDate('2028-02-28')).toBe('2028-02-29');
  });

  it('实际试用结束日期 = 转正日期前一天（15 §5）', () => {
    expect(actualProbationEndDate('2027-01-01')).toBe('2026-12-31');
  });

  it('只给月数时推算预计结束日；手填的预计结束日保留；无试用期清空其余字段', () => {
    const base = { hasProbation: true, startDate: '2026-10-16', months: 1, expectedEndDate: null };
    expect(normalizeProbationInfo(base).expectedEndDate).toBe('2026-11-15');
    expect(normalizeProbationInfo({ ...base, expectedEndDate: '2026-11-20' }).expectedEndDate).toBe('2026-11-20');
    expect(normalizeProbationInfo({ ...base, hasProbation: false })).toEqual({
      hasProbation: false,
      startDate: null,
      months: null,
      expectedEndDate: null,
    });
  });
});

describe('调整试用信息校验（PB-R11 / R12，W-597）', () => {
  const input = {
    hasProbation: true,
    startDate: '2026-09-01',
    months: 3,
    expectedEndDate: '2026-11-30',
    regularizationDate: null,
  };
  const facts: { entryDate: string; regularizationDate: string | null; today: string } = {
    entryDate: '2026-09-01',
    regularizationDate: null,
    today: '2026-10-20',
  };
  const reason = (value: Parameters<typeof probationAdjustmentViolation>[0], f = facts) =>
    probationAdjustmentViolation(value, f)?.reason ?? null;

  it('合法输入通过；无试用期不校验日期', () => {
    expect(reason(input)).toBeNull();
    expect(reason({ ...input, hasProbation: false, startDate: null, expectedEndDate: null })).toBeNull();
  });

  it('PB-R12：开始日早于入职日、结束日早于开始日、缺日期均拒绝', () => {
    expect(reason({ ...input, startDate: '2026-08-31' })).toBe('PROBATION_START_BEFORE_ENTRY');
    expect(reason({ ...input, expectedEndDate: '2026-08-31', startDate: '2026-09-02' })).toBe(
      'PROBATION_END_BEFORE_START',
    );
    expect(reason({ ...input, expectedEndDate: null })).toBe('PROBATION_DATES_REQUIRED');
  });

  it('PB-R11：已有生效（含审批通过未到期）转正记录时，转正日期不能清空、不能改为无试用期', () => {
    const regularized = { ...facts, regularizationDate: '2026-10-15' };
    const cleared = probationAdjustmentViolation(input, regularized);
    expect(cleared).toMatchObject({ reason: 'PROBATION_REGULARIZATION_DATE_REQUIRED', kind: 'conflict' });
    expect(cleared?.message).toBe('该人员已存在生效的转正任职记录，转正日期不允许清空');
    expect(reason({ ...input, hasProbation: false, regularizationDate: '2026-10-15' }, regularized)).toBe(
      'PROBATION_REGULARIZED',
    );
    expect(reason({ ...input, regularizationDate: '2026-10-16' }, regularized)).toBe(
      'PROBATION_REGULARIZATION_DATE_MISMATCH',
    );
    expect(reason({ ...input, regularizationDate: '2026-10-15' }, regularized)).toBeNull();
  });

  it('PB-R10：转正记录未到生效日时，带回原转正日期也拒绝；未填转正日期仍先报原站原文', () => {
    const pending = { ...facts, regularizationDate: '2026-10-25' };
    expect(reason({ ...input, regularizationDate: '2026-10-25' }, pending)).toBe(
      'PROBATION_REGULARIZATION_NOT_EFFECTIVE',
    );
    expect(reason(input, pending)).toBe('PROBATION_REGULARIZATION_DATE_REQUIRED');
    expect(reason({ ...input, regularizationDate: '2026-10-25' }, { ...pending, today: '2026-10-25' })).toBeNull();
  });

  it('没有转正记录时不能填写实际转正日期', () => {
    expect(reason({ ...input, regularizationDate: '2026-10-15' })).toBe('PROBATION_REGULARIZATION_DATE_WITHOUT_RECORD');
  });
});
