import { describe, expect, it } from 'vitest';
import {
  BLACKLIST_REASONS,
  type BlacklistRuleFacts,
  blacklistBlockedMessage,
  isBlacklistEffective,
  matchBlacklistRule,
} from './blacklist.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const CHILD = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

function rule(id: string, priority: number, minExits: number, orgIds = [ORG]): BlacklistRuleFacts {
  return {
    id,
    name: id,
    priority,
    orgIds,
    conditions: [{ field: 'exitCount', operator: 'gte', value: minExits }],
    term: 'permanent',
    reason: 'instability',
    note: null,
  };
}

describe('黑名单有效判定与提示原文（DEC-569）', () => {
  it('原因选项原文；截止日期为空 = 永久；截止日当天仍有效、次日失效；已移出不算', () => {
    expect(Object.values(BLACKLIST_REASONS)).toEqual([
      '重大违纪',
      '诚信问题',
      '稳定性差',
      '辞职',
      '其他(当月离职人员不能当月再入职)',
    ]);
    expect(isBlacklistEffective({ status: 'active', expiryDate: null }, '2026-10-01')).toBe(true);
    expect(isBlacklistEffective({ status: 'active', expiryDate: '2026-10-01' }, '2026-10-01')).toBe(true);
    expect(isBlacklistEffective({ status: 'active', expiryDate: '2026-09-30' }, '2026-10-01')).toBe(false);
    expect(isBlacklistEffective({ status: 'removed', expiryDate: null }, '2026-10-01')).toBe(false);
    expect(blacklistBlockedMessage('张三', 'other')).toBe(
      '此人员已被列入黑名单（姓名：张三，原因：其他(当月离职人员不能当月再入职)），无法执行此操作',
    );
  });
});

describe('离职自动加黑规则匹配（多条命中取优先级数字最小者）', () => {
  it('离职次数 ≥ N 才命中；多条命中取优先级最小；同优先级取先登记者；适用组织含下级', () => {
    const rules = [rule('every-exit', 20, 1), rule('third-exit', 10, 3), rule('tie', 10, 3)];
    expect(matchBlacklistRule(rules, { exitCount: 1, orgChain: [CHILD, ORG] })?.id).toBe('every-exit');
    expect(matchBlacklistRule(rules, { exitCount: 3, orgChain: [CHILD, ORG] })?.id).toBe('third-exit');
    expect(matchBlacklistRule(rules, { exitCount: 0, orgChain: [ORG] })).toBeNull();
    expect(matchBlacklistRule(rules, { exitCount: 5, orgChain: [OTHER] })).toBeNull();
  });

  it('多个条件同时满足才命中', () => {
    const both: BlacklistRuleFacts = {
      ...rule('both', 1, 2),
      conditions: [
        { field: 'exitCount', operator: 'gte', value: 2 },
        { field: 'exitCount', operator: 'gte', value: 4 },
      ],
    };
    expect(matchBlacklistRule([both], { exitCount: 3, orgChain: [ORG] })).toBeNull();
    expect(matchBlacklistRule([both], { exitCount: 4, orgChain: [ORG] })?.id).toBe('both');
  });
});
