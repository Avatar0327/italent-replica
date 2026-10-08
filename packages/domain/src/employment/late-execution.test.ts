import { describe, expect, it } from 'vitest';
import { resolveLateExecution, resolveLateLeave } from './late-execution.js';

describe('DEC-272 迟到判定（#83 / #100 共用）', () => {
  it.each([
    ['生效日当天执行，不顺延', '2026-10-05', '2026-10-05', { late: false, effectiveDate: '2026-10-05' }],
    ['晚 1 天执行，顺延到执行日', '2026-10-05', '2026-10-06', { late: true, effectiveDate: '2026-10-06' }],
    ['跨月执行，顺延到执行日', '2026-10-31', '2026-11-02', { late: true, effectiveDate: '2026-11-02' }],
    ['提前执行不属迟到，保持原定生效日', '2026-10-05', '2026-10-04', { late: false, effectiveDate: '2026-10-05' }],
  ])('调动：%s', (_name, plannedEffectiveDate, executionDate, expected) => {
    expect(resolveLateExecution({ plannedEffectiveDate, executionDate })).toEqual(expected);
  });

  it.each([
    [
      '原定生效日当天执行，不顺延',
      '2026-10-05',
      '2026-10-06',
      { late: false, lastWorkDate: '2026-10-05', effectiveDate: '2026-10-06' },
    ],
    [
      '晚 1 天执行，最后工作日改为执行日前一天',
      '2026-10-05',
      '2026-10-07',
      { late: true, lastWorkDate: '2026-10-06', effectiveDate: '2026-10-07' },
    ],
    ['跨月执行', '2026-10-31', '2026-11-03', { late: true, lastWorkDate: '2026-11-02', effectiveDate: '2026-11-03' }],
    [
      '最后工作日当天执行（尚未到原定生效日）不属迟到',
      '2026-10-05',
      '2026-10-05',
      { late: false, lastWorkDate: '2026-10-05', effectiveDate: '2026-10-06' },
    ],
  ])('离职：%s', (_name, lastWorkDate, executionDate, expected) => {
    expect(resolveLateLeave({ lastWorkDate, executionDate })).toEqual(expected);
  });
});
