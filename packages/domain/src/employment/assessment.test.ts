import { describe, expect, it } from 'vitest';
import {
  assessmentOpinionViolation,
  assessmentRegularization,
  isParallelRuleValue,
  parallelAllows,
  PARALLEL_RULE_DEFAULT,
  processOfAction,
  type AssessmentOpinion,
  type AssessmentType,
} from './assessment.js';

const plan = (type: AssessmentType, opinion: AssessmentOpinion | null, regularizationDate: string | null = null) =>
  assessmentRegularization({ type, opinion, regularizationDate });

describe('转正意见 → 是否生成转正记录（PB-R4 / PB-R5）', () => {
  it('试用中考核：只有提前转正生成，生效日 = 提前转正日期', () => {
    expect(plan('probation', 'early', '2026-10-15')).toEqual({
      generate: true,
      effectiveDate: '2026-10-15',
      probationResult: 'early',
    });
    for (const opinion of ['normal', 'delayed', 'failed', 'extended'] as const)
      expect(plan('probation', opinion, '2026-10-15').generate, opinion).toBe(false);
    expect(plan('probation', null).generate).toBe(false);
  });

  it('转正考核：正常 / 提前 / 延期转正生成（正常转正没填日期取默认），不通过与延期试用不生成', () => {
    expect(plan('regularization', 'normal')).toEqual({
      generate: true,
      effectiveDate: null,
      probationResult: 'normal',
    });
    expect(plan('regularization', 'early', '2026-10-15')).toMatchObject({ generate: true, probationResult: 'early' });
    expect(plan('regularization', 'delayed', '2026-12-20')).toMatchObject({
      generate: true,
      effectiveDate: '2026-12-20',
      probationResult: 'delayed',
    });
    expect(plan('regularization', 'failed').generate).toBe(false);
    expect(plan('regularization', 'extended').generate).toBe(false);
  });

  it('提前 / 延期转正必须有转正日期', () => {
    expect(assessmentOpinionViolation({ type: 'probation', opinion: 'early', regularizationDate: null })).toMatchObject(
      {
        reason: 'ASSESSMENT_DATE_REQUIRED',
      },
    );
    expect(
      assessmentOpinionViolation({ type: 'regularization', opinion: 'delayed', regularizationDate: null }),
    ).not.toBeNull();
    expect(
      assessmentOpinionViolation({ type: 'regularization', opinion: 'normal', regularizationDate: null }),
    ).toBeNull();
    expect(assessmentOpinionViolation({ type: 'probation', opinion: null, regularizationDate: null })).toBeNull();
  });
});

describe('并行规则（PB-R9 例外）', () => {
  it('取值严格：{ enabled, allowed }，allowed 只能取本开关的候选且不重复', () => {
    expect(isParallelRuleValue('regularization_assessment', PARALLEL_RULE_DEFAULT)).toBe(true);
    expect(isParallelRuleValue('regularization_assessment', { enabled: true, allowed: ['regularization'] })).toBe(true);
    expect(isParallelRuleValue('regularization_assessment', { enabled: true, allowed: ['probation_assessment'] })).toBe(
      false,
    );
    expect(isParallelRuleValue('probation_assessment', { enabled: true, allowed: ['probation_assessment'] })).toBe(
      true,
    );
    expect(
      isParallelRuleValue('probation_assessment', { enabled: true, allowed: ['regularization', 'regularization'] }),
    ).toBe(false);
    for (const bad of [
      null,
      [],
      'x',
      { enabled: true },
      { enabled: 1, allowed: [] },
      { enabled: true, allowed: [], x: 1 },
    ])
      expect(isParallelRuleValue('probation_assessment', bad), JSON.stringify(bad)).toBe(false);
  });

  it('放行 = 开关打开且勾选了所发起的流程；调整试用期不是流程发起，没有例外', () => {
    const rule = { enabled: true, allowed: ['regularization'] as const };
    expect(parallelAllows(rule, processOfAction('apply'))).toBe(true);
    expect(parallelAllows(rule, processOfAction('regularize'))).toBe(true);
    expect(parallelAllows(rule, processOfAction('assess_regularization'))).toBe(false);
    expect(parallelAllows(rule, processOfAction('adjust'))).toBe(false);
    expect(parallelAllows({ ...rule, enabled: false }, 'regularization')).toBe(false);
    expect(parallelAllows(PARALLEL_RULE_DEFAULT, 'regularization')).toBe(false);
  });
});
