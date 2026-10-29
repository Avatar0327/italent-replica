/**
 * R2 BE-5c1b（R2-T04 §9.1 / §9.1A，AC-RT-16、AC-RT-03 补充；DEC-641）：
 * 按 purpose 匹配规则并返回计算结果（供 5c2 批次与立即执行调用）：
 * - expected_date：固定年龄规则按 A-4 取月末；内置法定函数规则按 DEC-641① 取“+1 天”；两种规则并存、互不改写；
 * - flexible_range：只选内置函数，上下限随人事当前预计退休日期 P；P 为空 → 上下限都空（A-20）；
 * - 命中第一条即停；预置法定规则先于自建（DEC-646②），法定算不出再回落自建；无命中返回 null（由调用方决定是否清空）。
 */
import { describe, expect, it } from 'vitest';
import {
  resolveExpectedDate,
  resolveFlexibleRange,
  type RetirementCondition,
  type RetirementPerson,
  type RetirementRule,
} from '../../packages/domain/src/employment/retirement-rules.js';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const internal: RetirementCondition = { fieldCode: 'employType', operator: 'in', values: ['internal'] };

const base = {
  enabled: true,
  priority: 10,
  sequenceNo: 1,
  scopeOrgIds: [ORG],
  conditions: [internal],
} as const;

const fixedAge = (id: string, patch: Partial<RetirementRule> = {}): RetirementRule => ({
  ...base,
  id,
  purpose: 'expected_date',
  ruleType: 'fixed_age',
  retirementAgeYears: 60,
  retirementAgeMonths: 0,
  ...patch,
});
const statutoryExpected = (id: string, patch: Partial<RetirementRule> = {}): RetirementRule => ({
  ...base,
  id,
  purpose: 'expected_date',
  ruleType: 'builtin',
  retirementAgeYears: null,
  retirementAgeMonths: null,
  expectedFunction: 'statutory_expected_date',
  ...patch,
});
const presetExpected = (id: string, patch: Partial<RetirementRule> = {}) =>
  statutoryExpected(id, { priority: 9999, preset: true, scopeOrgIds: [], scopeAllOrgs: true, ...patch });
const statutoryRange = (id: string, patch: Partial<RetirementRule> = {}): RetirementRule => ({
  ...base,
  id,
  purpose: 'flexible_range',
  ruleType: 'builtin',
  retirementAgeYears: null,
  retirementAgeMonths: null,
  earliestFunction: 'statutory_earliest',
  latestFunction: 'statutory_latest',
  ...patch,
});

const man: RetirementPerson = {
  orgId: ORG,
  gender: 'male',
  nationality: 'CN',
  employType: 'internal',
  identityType: null,
};
const worker: RetirementPerson = { ...man, gender: 'female', identityType: '10' };

describe('AC-RT-16 resolveExpectedDate：固定年龄与法定函数并存', () => {
  it('固定年龄规则：出生日期 + 年龄取月末（A-4，不 +1 天）', () => {
    const hit = resolveExpectedDate([fixedAge('f')], man, { birthday: '1965-03-15', expectedDate: null });
    expect(hit).toMatchObject({ rule: { id: 'f' }, date: '2025-03-31' });
  });

  it('法定函数规则：改革后退休年龄 + 1 天，与固定年龄规则互不改写', () => {
    const facts = { birthday: '1965-03-15', expectedDate: null };
    expect(resolveExpectedDate([statutoryExpected('s')], man, facts)).toMatchObject({ date: '2025-04-16' });
    expect(resolveExpectedDate([fixedAge('f')], man, facts)).toMatchObject({ date: '2025-03-31' });
  });

  it('命中规则但出生日期空 / 女性无个人身份 → date 为 null（规则仍算命中）；无命中 → null', () => {
    const rule = statutoryExpected('s');
    expect(resolveExpectedDate([rule], man, { birthday: null, expectedDate: null })).toMatchObject({ date: null });
    expect(
      resolveExpectedDate([rule], { ...worker, identityType: null }, { birthday: '1980-01-01', expectedDate: null }),
    ).toMatchObject({ rule: { id: 's' }, date: null });
    expect(
      resolveExpectedDate([rule], { ...man, employType: 'external' }, { birthday: '1980-01-01', expectedDate: null }),
    ).toBeNull();
  });

  it('法定优先（DEC-646②）：自建与预置同时命中，取预置，哪怕自建优先级数值更小', () => {
    const custom = fixedAge('custom', { priority: 0, sequenceNo: 1 });
    const preset = presetExpected('preset');
    const facts = { birthday: '1990-06-15', expectedDate: null };
    expect(resolveExpectedDate([custom, preset], man, facts)).toMatchObject({
      rule: { id: 'preset' },
      date: '2053-06-16',
    });
    expect(resolveExpectedDate([{ ...preset, enabled: false }, custom], man, facts)?.rule.id).toBe('custom');
  });

  it('验收例：销售部男 62 岁自建规则，对法定可算的人不生效；法定未命中的人才用自建', () => {
    const custom = fixedAge('sales62', { retirementAgeYears: 62 });
    const preset = presetExpected('preset', { conditions: [{ ...internal, values: ['internal'] }] });
    const facts = { birthday: '1990-06-15', expectedDate: null };
    expect(resolveExpectedDate([custom, preset], man, facts)).toMatchObject({
      rule: { id: 'preset' },
      date: '2053-06-16',
    });
    // 实习生不在法定规则的雇佣关系范围内：法定未命中，自建（雇佣关系含实习）生效
    const intern = { ...man, employType: 'intern' };
    const customIntern = { ...custom, conditions: [{ ...internal, values: ['intern'] }] };
    expect(resolveExpectedDate([customIntern, preset], intern, facts)).toMatchObject({
      rule: { id: 'sales62' },
      date: '2052-06-30',
    });
  });

  it('女性个人身份为空：法定算不出，有自建就用自建，没有就留空（DEC-646①）', () => {
    const facts = { birthday: '1990-06-15', expectedDate: null };
    const woman = { ...worker, identityType: null };
    const preset = presetExpected('preset');
    const custom = fixedAge('custom', { retirementAgeYears: 55 });
    expect(resolveExpectedDate([preset, custom], woman, facts)).toMatchObject({
      rule: { id: 'custom' },
      date: '2045-06-30',
    });
    expect(resolveExpectedDate([preset], woman, facts)).toMatchObject({ rule: { id: 'preset' }, date: null });
  });

  it('预置规则覆盖全公司：员工主职部门为空也命中', () => {
    const preset = statutoryExpected('preset', { preset: true, scopeOrgIds: [], scopeAllOrgs: true });
    expect(
      resolveExpectedDate([preset], { ...man, orgId: null }, { birthday: '1990-06-15', expectedDate: null }),
    ).toMatchObject({ date: '2053-06-16' });
  });

  it('flexible_range 规则不参与 expected_date', () => {
    expect(resolveExpectedDate([statutoryRange('r')], man, { birthday: '1990-06-15', expectedDate: null })).toBeNull();
  });
});

describe('AC-RT-16 resolveFlexibleRange：法定最早 / 最晚', () => {
  it('P 非空：最早 = 出生 + 原法定年龄 + 1 天，最晚 = P + 3 年', () => {
    const facts = { birthday: '1990-06-15', expectedDate: '2053-06-16' };
    expect(resolveFlexibleRange([statutoryRange('r')], man, facts)).toMatchObject({
      rule: { id: 'r' },
      earliest: '2050-06-16',
      latest: '2056-06-16',
    });
  });

  it('P 为空 → 上下限都空（A-20），规则仍算命中', () => {
    const facts = { birthday: '1990-06-15', expectedDate: null };
    expect(resolveFlexibleRange([statutoryRange('r')], man, facts)).toMatchObject({
      rule: { id: 'r' },
      earliest: null,
      latest: null,
    });
  });

  it('女性个人身份为空：最早留空（不限制），最晚照算', () => {
    const facts = { birthday: '1980-05-20', expectedDate: '2033-02-21' };
    expect(resolveFlexibleRange([statutoryRange('r')], { ...worker, identityType: null }, facts)).toMatchObject({
      earliest: null,
      latest: '2036-02-21',
    });
  });

  it('P 早于算出的最早日期 → 最早取 P', () => {
    const facts = { birthday: '1990-06-15', expectedDate: '2049-01-01' };
    expect(resolveFlexibleRange([statutoryRange('r')], man, facts)).toMatchObject({
      earliest: '2049-01-01',
      latest: '2052-01-01',
    });
  });

  it('法定优先（DEC-646②类推）：法定上下限算得出就用它；法定未命中才回落自建；P 为空时仍取法定命中者', () => {
    const preset = statutoryRange('preset', { priority: 9999, preset: true, scopeOrgIds: [], scopeAllOrgs: true });
    const custom = statutoryRange('custom', { priority: 0 });
    const facts = { birthday: '1990-06-15', expectedDate: '2053-06-16' };
    expect(resolveFlexibleRange([custom, preset], man, facts)?.rule.id).toBe('preset');
    const intern = { ...man, employType: 'intern' };
    const presetInternal = { ...preset, conditions: [internal] };
    const customIntern = { ...custom, conditions: [{ ...internal, values: ['intern'] }] };
    expect(resolveFlexibleRange([customIntern, presetInternal], intern, facts)?.rule.id).toBe('custom');
    const empty = { birthday: '1990-06-15', expectedDate: null };
    expect(resolveFlexibleRange([custom, preset], man, empty)).toMatchObject({ rule: { id: 'preset' }, latest: null });
  });

  it('命中第一条即停：条件不满足顺延到下一条；expected_date 规则不参与；无命中 → null', () => {
    const femaleOnly = statutoryRange('female-only', {
      priority: 1,
      conditions: [internal, { fieldCode: 'gender', operator: 'in', values: ['female'] }],
    });
    const anyone = statutoryRange('anyone', { priority: 2 });
    const facts = { birthday: '1990-06-15', expectedDate: '2053-06-16' };
    expect(resolveFlexibleRange([femaleOnly, anyone, fixedAge('x', { priority: 0 })], man, facts)?.rule.id).toBe(
      'anyone',
    );
    expect(resolveFlexibleRange([femaleOnly], man, facts)).toBeNull();
    expect(resolveFlexibleRange([fixedAge('x')], man, facts)).toBeNull();
  });
});
