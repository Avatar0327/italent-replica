/**
 * R2 BE-5c1a（R2-T04 §9.1，RT-R5，AC-RT-03 纯函数部分；DEC-640 固定槽位）：
 * 员工匹配多条规则时取优先级最高（同优先级取序号小）的一条，不再匹配其他；停用规则不参与；
 * 条件只有四个固定槽位（性别、国籍、雇佣关系、个人身份），每槽 in（多选命中其一），槽位之间 AND。
 */
import { describe, expect, it } from 'vitest';
import {
  matchRule,
  type RetirementCondition,
  type RetirementPerson,
  type RetirementRule,
} from '../../packages/domain/src/employment/retirement-rules.js';

const ORG_A = 'a0000000-0000-4000-8000-000000000001';
const ORG_B = 'b0000000-0000-4000-8000-000000000002';

const internal: RetirementCondition = { fieldCode: 'employType', operator: 'in', values: ['internal'] };

function rule(id: string, patch: Partial<RetirementRule> = {}): RetirementRule {
  return {
    id,
    purpose: 'expected_date',
    ruleType: 'fixed_age',
    enabled: true,
    priority: 10,
    sequenceNo: 1,
    scopeOrgIds: [ORG_A],
    retirementAgeYears: 60,
    retirementAgeMonths: 0,
    conditions: [internal],
    ...patch,
  };
}

const person: RetirementPerson = {
  orgId: ORG_A,
  gender: 'male',
  nationality: 'CN',
  employType: 'internal',
  identityType: '20',
};

describe('AC-RT-03 预计退休日期规则匹配（纯函数）', () => {
  it('匹配两条规则：取优先级数值小者，不再匹配其他', () => {
    const rules = [rule('low', { priority: 20 }), rule('high', { priority: 5 }), rule('mid', { priority: 10 })];
    expect(matchRule(rules, person)?.id).toBe('high');
  });

  it('同优先级取登记序号小者', () => {
    const rules = [
      rule('late', { sequenceNo: 3 }),
      rule('early', { sequenceNo: 1 }),
      rule('middle', { sequenceNo: 2 }),
    ];
    expect(matchRule(rules, person)?.id).toBe('early');
  });

  it('命中第一条即停：高优先级规则条件不满足时顺延到下一条', () => {
    const rules = [
      rule('female-only', {
        priority: 1,
        conditions: [internal, { fieldCode: 'gender', operator: 'in', values: ['female'] }],
      }),
      rule('anyone', { priority: 2 }),
    ];
    expect(matchRule(rules, person)?.id).toBe('anyone');
  });

  it('停用规则不参与；其他 purpose 的规则不参与', () => {
    const rules = [
      rule('off', { priority: 1, enabled: false }),
      rule('other-purpose', { priority: 2, purpose: 'flexible_range' }),
      rule('on', { priority: 3 }),
    ];
    expect(matchRule(rules, person)?.id).toBe('on');
    expect(matchRule([rules[0]!], person)).toBeNull();
  });

  it('组织范围：员工主职部门不在适用组织（已按包含下级展开）内不命中；部门为空不命中', () => {
    const rules = [rule('b-only', { scopeOrgIds: [ORG_B] })];
    expect(matchRule(rules, person)).toBeNull();
    expect(matchRule([rule('a-and-b', { scopeOrgIds: [ORG_B, ORG_A] })], person)?.id).toBe('a-and-b');
    expect(matchRule([rule('any')], { ...person, orgId: null })).toBeNull();
  });

  it('槽位之间 AND、槽内多选命中其一', () => {
    const multi = rule('multi', {
      conditions: [
        { fieldCode: 'employType', operator: 'in', values: ['internal', 'intern'] },
        { fieldCode: 'gender', operator: 'in', values: ['male'] },
        { fieldCode: 'nationality', operator: 'in', values: ['CN', 'HK'] },
        { fieldCode: 'identityType', operator: 'in', values: ['10', '20'] },
      ],
    });
    expect(matchRule([multi], person)?.id).toBe('multi');
    expect(matchRule([multi], { ...person, employType: 'external' })).toBeNull();
    expect(matchRule([multi], { ...person, gender: 'female' })).toBeNull();
    expect(matchRule([multi], { ...person, nationality: 'US' })).toBeNull();
    expect(matchRule([multi], { ...person, identityType: '30' })).toBeNull();
  });

  it('员工在条件槽位上没有值（空）时该条件不满足', () => {
    const identity: RetirementCondition = { fieldCode: 'identityType', operator: 'in', values: ['10'] };
    const rules = [rule('id-worker', { conditions: [internal, identity] })];
    expect(matchRule(rules, { ...person, identityType: null })).toBeNull();
    expect(matchRule(rules, { ...person, identityType: '10' })?.id).toBe('id-worker');
  });

  it('无规则或无命中返回 null，不兜底', () => {
    expect(matchRule([], person)).toBeNull();
    expect(matchRule([rule('x', { conditions: [{ ...internal, values: ['intern'] }] })], person)).toBeNull();
  });

  it('purpose = flexible_range：只在弹性范围规则里命中第一条即停，expected_date 规则不参与（5c1b）', () => {
    const range = (id: string, patch: Partial<RetirementRule> = {}) =>
      rule(id, {
        purpose: 'flexible_range',
        ruleType: 'builtin',
        retirementAgeYears: null,
        retirementAgeMonths: null,
        earliestFunction: 'statutory_earliest',
        latestFunction: 'statutory_latest',
        ...patch,
      });
    const rules = [
      rule('expected-date-first', { priority: 0 }),
      range('female-only', {
        priority: 1,
        conditions: [internal, { fieldCode: 'gender', operator: 'in', values: ['female'] }],
      }),
      range('second', { priority: 2 }),
      range('third', { priority: 3 }),
    ];
    expect(matchRule(rules, person, 'flexible_range')?.id).toBe('second');
    expect(matchRule(rules, person, 'expected_date')?.id).toBe('expected-date-first');
    expect(matchRule([rules[0]!, rules[1]!], person, 'flexible_range')).toBeNull();
    expect(matchRule([range('off', { enabled: false })], person, 'flexible_range')).toBeNull();
  });

  it('预置规则排在自建规则之前（DEC-646②，不论优先级数值）；预置规则覆盖全公司，部门为空也命中', () => {
    const preset = rule('preset', { priority: 0, preset: true, scopeOrgIds: [], scopeAllOrgs: true });
    const custom = rule('custom', { priority: 9999, sequenceNo: 9 });
    expect(matchRule([preset, custom], person)?.id).toBe('preset');
    expect(matchRule([custom, { ...preset, enabled: false }], person)?.id).toBe('custom');
    expect(matchRule([preset], { ...person, orgId: ORG_B })?.id).toBe('preset');
    expect(matchRule([preset], { ...person, orgId: null })?.id).toBe('preset');
    expect(matchRule([preset, rule('custom-off', { enabled: false })], person)?.id).toBe('preset');
  });
});
