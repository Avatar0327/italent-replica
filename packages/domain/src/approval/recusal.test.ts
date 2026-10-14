/**
 * F-048 回避判定纯函数（设计 §2.3、§2.4、§9.1、§9.2）：两个节点开关 × 角色逐格；实例级不受开关影响；
 * 账号来源只按冻结账号比较；UUID 大小写写法（DEC-194）。
 */
import { describe, expect, it } from 'vitest';
import { instanceRecusal, nodeRecusal, recusalFacts, type RecusalHit, type Who } from './recusal.js';

const INITIATOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const PRIMARY_EMP = 'bbbbbbbb-0000-4000-8000-000000000002';
const PRIMARY_USER = 'cccccccc-0000-4000-8000-000000000003';
const OTHER_EMP = 'dddddddd-0000-4000-8000-000000000004';
const OTHER_USER = 'eeeeeeee-0000-4000-8000-000000000005';
const OUTSIDER = 'ffffffff-0000-4000-8000-000000000006';

const facts = recusalFacts({
  initiatorUserId: INITIATOR,
  primaryEmployeeId: PRIMARY_EMP,
  primaryUserId: PRIMARY_USER,
  subjectEmployeeIds: [PRIMARY_EMP, OTHER_EMP],
  subjectUserIds: [PRIMARY_USER, OTHER_USER],
});

const ROLES: Record<string, Who> = {
  initiator: { userId: INITIATOR },
  primary: { userId: PRIMARY_USER },
  other: { userId: OTHER_USER },
  outsider: { userId: OUTSIDER },
};

const node = (avoidSelf: boolean, avoidSubjects: boolean) => ({ actions: { avoidSelf, avoidSubjects } });

describe('nodeRecusal：节点开关 × 角色（§9.1）', () => {
  const table: [boolean, boolean, Record<string, RecusalHit>][] = [
    [false, false, { initiator: null, primary: null, other: null, outsider: null }],
    [true, false, { initiator: 'self', primary: 'self', other: null, outsider: null }],
    [false, true, { initiator: null, primary: 'subjects', other: 'subjects', outsider: null }],
    [true, true, { initiator: 'self', primary: 'self', other: 'subjects', outsider: null }],
  ];
  for (const [avoidSelf, avoidSubjects, expected] of table) {
    for (const [role, who] of Object.entries(ROLES)) {
      it(`avoidSelf=${avoidSelf} / avoidSubjects=${avoidSubjects}：${role} → ${expected[role]}`, () => {
        expect(nodeRecusal(node(avoidSelf, avoidSubjects), who, facts)).toBe(expected[role]);
      });
    }
  }

  it('未给出开关的节点不回避（DEC-329④：新建节点缺省关闭）', () => {
    expect(nodeRecusal({}, ROLES.initiator!, facts)).toBeNull();
    expect(nodeRecusal({ actions: {} }, ROLES.other!, facts)).toBeNull();
  });

  it('员工来源的候选按人员 ID 命中，账号为空也命中；账号来源不看人员 ID（R2-02）', () => {
    const subjectsOnly = node(false, true);
    expect(nodeRecusal(subjectsOnly, { userId: null, personId: OTHER_EMP }, facts)).toBe('subjects');
    expect(nodeRecusal(node(true, false), { userId: null, personId: PRIMARY_EMP }, facts)).toBe('self');
    // 发起人账号：人员 ID 为空（外部账号）时仍按账号命中自审
    expect(nodeRecusal(node(true, false), { userId: INITIATOR, personId: null }, facts)).toBe('self');
    // 账号不在冻结集合中：即使给了人员 ID 也只按人员 ID 判断（人员不在 S）
    expect(nodeRecusal(subjectsOnly, { userId: OUTSIDER, personId: OUTSIDER }, facts)).toBeNull();
  });

  it('UUID 大小写写法不影响判定（DEC-194）', () => {
    expect(nodeRecusal(node(false, true), { userId: OTHER_USER.toUpperCase() }, facts)).toBe('subjects');
    expect(nodeRecusal(node(true, false), { userId: INITIATOR.toUpperCase() }, facts)).toBe('self');
    const upper = recusalFacts({
      initiatorUserId: INITIATOR.toUpperCase(),
      primaryEmployeeId: PRIMARY_EMP.toUpperCase(),
      primaryUserId: PRIMARY_USER.toUpperCase(),
      subjectEmployeeIds: [OTHER_EMP.toUpperCase()],
      subjectUserIds: [OTHER_USER.toUpperCase()],
    });
    expect(nodeRecusal(node(true, true), { userId: PRIMARY_USER }, upper)).toBe('self');
    expect(nodeRecusal(node(false, true), { userId: null, personId: OTHER_EMP }, upper)).toBe('subjects');
  });
});

describe('instanceRecusal：实例级不受开关影响（§9.2，DEC-329②）', () => {
  it('发起人、单主体、集合内其他主体都回避，无关人不回避', () => {
    expect(instanceRecusal(ROLES.initiator!, facts)).toBe(true);
    expect(instanceRecusal(ROLES.primary!, facts)).toBe(true);
    expect(instanceRecusal(ROLES.other!, facts)).toBe(true);
    expect(instanceRecusal(ROLES.outsider!, facts)).toBe(false);
    expect(instanceRecusal({ userId: null, personId: OTHER_EMP }, facts)).toBe(true);
  });

  it('IDP 所有者干预（DEC-321①）：发起人不回避，主体仍回避', () => {
    expect(instanceRecusal(ROLES.initiator!, facts, { exemptInitiator: true })).toBe(false);
    expect(instanceRecusal(ROLES.primary!, facts, { exemptInitiator: true })).toBe(true);
    expect(instanceRecusal(ROLES.other!, facts, { exemptInitiator: true })).toBe(true);
  });

  it('单主体并入集合：只给单主体时，集合为 {单主体}', () => {
    const single = recusalFacts({
      initiatorUserId: INITIATOR,
      primaryEmployeeId: PRIMARY_EMP,
      primaryUserId: PRIMARY_USER,
      subjectEmployeeIds: [],
      subjectUserIds: [],
    });
    expect([...single.subjectEmployeeIds]).toEqual([PRIMARY_EMP]);
    expect([...single.subjectUserIds]).toEqual([PRIMARY_USER]);
    expect(instanceRecusal(ROLES.primary!, single)).toBe(true);
    expect(instanceRecusal(ROLES.other!, single)).toBe(false);
  });
});
