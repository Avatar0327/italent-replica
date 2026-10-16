import { describe, expect, it } from 'vitest';
import {
  matchEmailRule,
  nextAvailableEmail,
  normalizeEmailDomain,
  planEntryEmail,
  validateEmailPrefix,
  type EmailCandidate,
  type EmailRuleFacts,
} from './entry-email.js';

const rule = (patch: Partial<EmailRuleFacts> = {}): EmailRuleFacts => ({
  id: 'r1',
  name: '规则',
  priority: 1,
  enabled: true,
  orgIds: ['d1'],
  employTypes: [],
  prefixField: 'employeeCode',
  domain: 'example.com',
  ...patch,
});
const candidate = (patch: Partial<EmailCandidate> = {}): EmailCandidate => ({
  kind: 'hire',
  orgChain: ['d1', 'root'],
  employType: 'internal',
  employeeCode: 'Zhangsan',
  namePinyin: null,
  pinyinInitials: null,
  ...patch,
});

describe('EN-R12 邮箱前缀与后缀', () => {
  it.each([
    ['zhangsan', null],
    ['zhang.san-1_x', null],
    ['', 'PREFIX_EMPTY'],
    ['zhang san', 'PREFIX_ILLEGAL'],
    ['.zhang', 'PREFIX_ILLEGAL'],
    ['zhang@', 'PREFIX_ILLEGAL'],
    ['张三', 'PREFIX_ILLEGAL'],
    ['a'.repeat(65), 'PREFIX_ILLEGAL'],
  ])('前缀 %s → %s', (prefix, reason) => expect(validateEmailPrefix(prefix)).toBe(reason));

  it.each([
    ['Example.COM', 'example.com'],
    ['@mail.example.com', 'mail.example.com'],
    ['example', null],
    ['-a.com', null],
    ['a b.com', null],
  ])('后缀 %s → %s', (input, expected) => expect(normalizeEmailDomain(input)).toBe(expected));
});

describe('EN-R12 重名序号', () => {
  it.each([
    [[], 'zhangsan@example.com'],
    [['zhangsan@example.com'], 'zhangsan1@example.com'],
    [['zhangsan@example.com', 'zhangsan1@example.com'], 'zhangsan2@example.com'],
    [['ZhangSan3@Example.com'], 'zhangsan4@example.com'],
    [['zhangsan1@example.com'], 'zhangsan2@example.com'],
    [['zhangsanli@example.com', 'zhangsan7@other.com'], 'zhangsan@example.com'],
  ])('已占用 %j → %s', (taken, expected) =>
    expect(nextAvailableEmail('zhangsan', 'example.com', taken)).toBe(expected),
  );

  it('前缀里的正则字符按字面量处理', () => {
    expect(nextAvailableEmail('a.b', 'example.com', ['axb1@example.com'])).toBe('a.b@example.com');
  });
});

describe('EN-R12 规则匹配与计划', () => {
  it('优先级数字小的先；同优先级按配置顺序；停用跳过', () => {
    const rules = [rule({ id: 'a', priority: 2 }), rule({ id: 'b', priority: 1 }), rule({ id: 'c', priority: 1 })];
    expect(matchEmailRule(rules, candidate())?.id).toBe('b');
    expect(matchEmailRule([rule({ enabled: false })], candidate())).toBeNull();
  });

  it('组织范围（含下级）与雇佣关系条件都要满足；没有部门不匹配', () => {
    const intern = rule({ employTypes: ['intern'] });
    expect(matchEmailRule([intern], candidate())).toBeNull();
    expect(matchEmailRule([intern], candidate({ employType: 'intern' }))?.id).toBe('r1');
    expect(matchEmailRule([rule()], candidate({ orgChain: ['other', 'root'] }))).toBeNull();
    expect(matchEmailRule([rule()], candidate({ orgChain: [] }))).toBeNull();
    // 上级在范围内即含下级
    expect(matchEmailRule([rule({ orgIds: ['root'] })], candidate({ orgChain: ['child', 'd1', 'root'] }))?.id).toBe(
      'r1',
    );
  });

  it('命中第一条即停止：前缀失败不再尝试下一条', () => {
    const rules = [rule({ id: 'first', priority: 1 }), rule({ id: 'second', priority: 2 })];
    expect(planEntryEmail(rules, candidate({ employeeCode: 'li si' }))).toMatchObject({
      status: 'failed',
      reason: 'PREFIX_ILLEGAL',
      ruleId: 'first',
    });
  });

  it('重聘 / 退休返聘 / 实习转正不生成；无规则；得到小写前缀', () => {
    for (const kind of ['rehire', 'retire_rehire', 'intern_regularization'])
      expect(planEntryEmail([rule()], candidate({ kind }))).toEqual({
        status: 'skipped',
        reason: 'REHIRE_NOT_GENERATED',
      });
    expect(planEntryEmail([], candidate())).toEqual({ status: 'no_rule' });
    expect(planEntryEmail([rule()], candidate())).toMatchObject({ status: 'plan', prefix: 'zhangsan' });
    expect(planEntryEmail([rule({ prefixField: 'namePinyin' })], candidate())).toMatchObject({
      reason: 'PREFIX_EMPTY',
    });
  });
});
