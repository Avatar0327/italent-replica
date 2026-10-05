import { describe, expect, it } from 'vitest';
import { countersignOutcome, countersignVote, exitRulesOf, exitThreshold } from './countersign.js';
import { definitionViolations, publishViolations } from './definition.js';
import { addSignerVotes, countersignEndedReason, previousNodeComparand } from './policies.js';
import { decideNode, type RoutingFacts } from './routing.js';
import {
  ADD_SIGN_TYPES,
  APPROVAL_TYPES,
  EXIT_TARGETS,
  NODE_ADD_SIGN_TYPES,
  TRANSITION_RULE_TYPES,
  type ApprovalNode,
  type CountersignApprovalNode,
  type ProcessDefinition,
  type SingleApprovalNode,
} from './types.js';

const base = {
  noAssignee: 'exception_admin',
  sameAssigneeSkip: false,
  historySameAssigneeSkip: false,
  sameAssigneeResult: 'approve',
  historySameAssigneeResult: 'approve',
  formFields: [],
  editableFields: [],
  editMode: 'none',
  actions: { transfer: false, addSign: false, copySend: false, retrieve: false, reject: true, urge: 'inherit' },
  rejectCommentRequired: false,
  hideRecords: false,
  rejectResubmit: 'restart',
  messageRules: [],
} as const;

const single = (extra: Partial<SingleApprovalNode> = {}): SingleApprovalNode => ({
  key: 'single',
  name: '单人',
  approver: 'record_department_head',
  ...base,
  ...extra,
});

const joint = (extra: Partial<CountersignApprovalNode> = {}): CountersignApprovalNode => ({
  key: 'joint',
  name: '会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
  transitionRule: { type: 'any' },
  ...base,
  ...extra,
});

const definition = (nodes: readonly ApprovalNode[]): ProcessDefinition => ({
  name: '流程',
  groupName: null,
  description: null,
  priority: 0,
  isFallback: true,
  exceptionAdminUserId: 'admin',
  urgeEnabled: true,
  hideRecordsFromInitiator: false,
  conditions: { items: [], expression: '' },
  nodes,
});

const count = (value: number) => ({ kind: 'count', value }) as const;
const percent = (value: number) => ({ kind: 'percent', value }) as const;

describe('DEC-155：多个出口动作同时达标时“不同意”优先', () => {
  it('席位合并使分母减少、同意与不同意同时达到规则时沿不同意流转', () => {
    const rules = { approve: { kind: 'percent', value: 50 }, disagree: { kind: 'percent', value: 50 } } as const;
    expect(countersignOutcome(rules, ['approve', 'disagree'])).toEqual({
      kind: 'flow',
      exit: 'disagree',
      count: 1,
      threshold: 1,
    });
  });
});

describe('DEC-144 会签流转规则（`14` §12.1）', () => {
  it('三种：任一人同意即可（默认）/ 需所有人同意 / 自定义审批方式', () => {
    expect(TRANSITION_RULE_TYPES).toEqual(['any', 'all', 'custom']);
  });

  it('预设规则按节点出口动作生成：任一人 = 每个动作整数 1；所有人 = 同意 100%、其他动作整数 1', () => {
    expect(exitRulesOf({ type: 'any' }, ['approve', 'disagree'])).toEqual({ approve: count(1), disagree: count(1) });
    expect(exitRulesOf({ type: 'all' }, ['approve', 'disagree'])).toEqual({
      approve: percent(100),
      disagree: count(1),
    });
    expect(exitRulesOf({ type: 'all' }, ['approve'])).toEqual({ approve: percent(100) });
    const rules = { approve: percent(50), disagree: count(2) };
    expect(exitRulesOf({ type: 'custom', rules }, ['approve', 'disagree'])).toEqual(rules);
  });

  it('百分比向上取整（5 人 50% → 3 人；可带两位小数），整数按原值', () => {
    expect(exitThreshold(percent(50), 5)).toBe(3);
    expect(exitThreshold(percent(100), 4)).toBe(4);
    expect(exitThreshold(percent(33.33), 3)).toBe(1);
    expect(exitThreshold(percent(66.67), 3)).toBe(3);
    expect(exitThreshold(percent(0.01), 1)).toBe(1);
    expect(exitThreshold(count(3), 2)).toBe(3);
  });

  it('某动作的点击人数先达到其规则即沿该动作流转；仍有在办票时待定；全部处理完仍无动作达到规则为“无法达成”', () => {
    const any = exitRulesOf({ type: 'any' }, ['approve', 'disagree']);
    expect(countersignOutcome(any, ['open', 'approve'])).toMatchObject({ kind: 'flow', exit: 'approve', count: 1 });
    expect(countersignOutcome(any, ['open', 'disagree'])).toMatchObject({ kind: 'flow', exit: 'disagree' });
    expect(countersignOutcome(any, ['open', 'open'])).toEqual({ kind: 'pending' });
    const all = exitRulesOf({ type: 'all' }, ['approve', 'disagree']);
    expect(countersignOutcome(all, ['approve', 'open'])).toEqual({ kind: 'pending' });
    expect(countersignOutcome(all, ['approve', 'approve'])).toMatchObject({ kind: 'flow', exit: 'approve', count: 2 });
    expect(countersignOutcome(all, ['approve', 'disagree', 'open'])).toMatchObject({ kind: 'flow', exit: 'disagree' });
    const custom = { approve: percent(50), disagree: count(2) };
    expect(countersignOutcome(custom, ['approve', 'approve', 'open', 'open', 'open'])).toEqual({ kind: 'pending' });
    expect(countersignOutcome(custom, ['approve', 'approve', 'approve', 'open', 'disagree'])).toEqual({
      kind: 'flow',
      exit: 'approve',
      count: 3,
      threshold: 3,
    });
    expect(countersignOutcome({ approve: count(2), disagree: count(2) }, ['approve', 'disagree'])).toEqual({
      kind: 'stalled',
    });
    expect(countersignOutcome({ approve: count(3) }, ['approve', 'approve'])).toEqual({ kind: 'stalled' });
  });

  it('任务状态折算成票：驳回、转交、自审留痕、取消、已结束的任务都不计票', () => {
    expect(countersignVote('approved')).toBe('approve');
    expect(countersignVote('disagreed')).toBe('disagree');
    for (const status of ['pending', 'queued', 'add_signed']) expect(countersignVote(status)).toBe('open');
    for (const status of ['rejected', 'transferred', 'skipped', 'cancelled', 'ended']) {
      expect(countersignVote(status)).toBeNull();
    }
  });

  it('暂定（Q-M0-57）：节点流转后其余未处理待办自动结束，记明原因', () => {
    expect(countersignEndedReason('approve')).toBe('因节点已通过而结束');
    expect(countersignEndedReason('disagree')).toBe('因节点已按不同意流转而结束');
  });
});

describe('加签类型按节点类型（`14` §11.4；DEC-095 / DEC-117 / DEC-152）', () => {
  it('单人节点有前 / 后加签；会签节点有前加签与并加签（DEC-152）', () => {
    expect(ADD_SIGN_TYPES).toEqual(['before', 'after', 'parallel']);
    expect(NODE_ADD_SIGN_TYPES).toEqual({ single: ['before', 'after'], countersign: ['before', 'parallel'] });
  });
  it('会签节点上并加签人计入流转规则，前加签人不计入（DEC-152 暂定）', () => {
    expect(addSignerVotes('parallel')).toBe(true);
    expect(addSignerVotes('before')).toBe(false);
  });
});

describe('出口动作的连线去向（DEC-144，`14` §12.2）', () => {
  it('「同意」进入下一节点，「不同意」连到结束（流程结束、业务不生效）', () => {
    expect(EXIT_TARGETS).toEqual({ approve: 'next', disagree: 'end' });
  });
});

describe('会签节点的定义校验', () => {
  const type = APPROVAL_TYPES.transfer;
  const violations = (node: ApprovalNode) => definitionViolations(definition([node]), type);
  it('合法的会签节点与单人节点没有违规', () => {
    expect(definitionViolations(definition([joint(), single()]), type)).toEqual([]);
    const custom = joint({
      exits: ['approve', 'disagree'],
      transitionRule: { type: 'custom', rules: { approve: percent(66.67), disagree: count(2) } },
    });
    expect(violations(custom)).toEqual([]);
  });
  it('审批人不能为空或重复', () => {
    expect(violations(joint({ approvers: [] }))).toHaveLength(1);
    expect(violations(joint({ approvers: ['record_department_head', 'record_department_head'] }))).toHaveLength(1);
  });
  it('自定义规则须逐个出口动作给出一行：整数 ≥1，百分比在 (0, 100] 且最多两位小数；预设不接受逐行规则', () => {
    const custom = (rules: object, exits: CountersignApprovalNode['exits'] = ['approve', 'disagree']) =>
      joint({ exits, transitionRule: { type: 'custom', rules } as CountersignApprovalNode['transitionRule'] });
    expect(violations(custom({ approve: count(1) }))).toHaveLength(1);
    expect(violations(custom({ approve: count(1), disagree: count(1) }, ['approve']))).toHaveLength(1);
    expect(violations(custom({ approve: count(0), disagree: count(1) }))).toHaveLength(1);
    expect(violations(custom({ approve: count(1.5), disagree: count(1) }))).toHaveLength(1);
    expect(violations(custom({ approve: percent(0), disagree: count(1) }))).toHaveLength(1);
    expect(violations(custom({ approve: percent(100.5), disagree: count(1) }))).toHaveLength(1);
    expect(violations(custom({ approve: percent(33.333), disagree: count(1) }))).toHaveLength(1);
    expect(violations(joint({ transitionRule: { type: 'any', rules: { approve: count(2) } } }))).toHaveLength(1);
    expect(violations(joint({ transitionRule: { type: 'ratio' as 'any' } }))).toHaveLength(1);
  });
  it('DEC-106：会签节点的自动处理结果只能为「同意」，「跳过」仅单人节点可选', () => {
    expect(violations(joint({ sameAssigneeSkip: true, sameAssigneeResult: 'skip' }))).toHaveLength(1);
    expect(violations(joint({ historySameAssigneeSkip: true, historySameAssigneeResult: 'skip' }))).toHaveLength(1);
    expect(violations(single({ sameAssigneeSkip: true, sameAssigneeResult: 'skip' }))).toEqual([]);
  });
  it('出口动作不能为空或重复', () => {
    expect(violations(single({ exits: [] }))).toHaveLength(1);
    expect(violations(single({ exits: ['approve', 'approve'] }))).toHaveLength(1);
  });
});

describe('发布校验：开启加签须有「同意」出口线（`14` §11.4，CustomerKB 109710739）', () => {
  const withAddSign = { ...base.actions, addSign: true };
  it('勾选加签而没有同意出口动作：发布被拒，提示照原站', () => {
    const node = single({ name: '调入部门HRBP审核', actions: withAddSign, exits: ['disagree'] });
    expect(publishViolations(definition([node]))).toEqual([
      {
        reason: 'APPROVAL_ADD_SIGN_APPROVE_EXIT_REQUIRED',
        message: '勾选加签的调入部门HRBP审核节点必须配置同意出口线',
      },
    ]);
    const countersign = joint({ actions: withAddSign, exits: ['disagree'] });
    expect(publishViolations(definition([countersign])).map((v) => v.reason)).toEqual([
      'APPROVAL_ADD_SIGN_APPROVE_EXIT_REQUIRED',
    ]);
  });
  it('开启相同 / 历史相同审批人自动处理而没有同意出口动作：发布被拒（自动处理沿同意线走，`14` §11.6）', () => {
    expect(publishViolations(definition([single({ sameAssigneeSkip: true, exits: ['disagree'] })]))).toMatchObject([
      { reason: 'APPROVAL_AUTO_APPROVE_EXIT_REQUIRED' },
    ]);
    const history = single({ historySameAssigneeSkip: true, exits: ['disagree'] });
    expect(publishViolations(definition([history]))).toMatchObject([{ reason: 'APPROVAL_AUTO_APPROVE_EXIT_REQUIRED' }]);
  });
  it('缺省只有同意出口动作，可以发布；不加签也不自动处理时只有不同意也可以发布', () => {
    expect(publishViolations(definition([single({ actions: withAddSign })]))).toEqual([]);
    expect(publishViolations(definition([single({ exits: ['disagree'] })]))).toEqual([]);
  });
});

describe('DEC-114 扩展：上一节点是会签时，比较对象是它解析出的全部候选人', () => {
  const facts = (extra: Partial<RoutingFacts>): RoutingFacts => ({
    isFirstNode: false,
    initiatorUserId: 'initiator',
    subjectEmployeeId: null,
    subjectUserId: null,
    exceptionAdminUserId: 'admin',
    previousApproverUserIds: [],
    approvedUserIds: [],
    chainUserIds: [],
    ...extra,
  });
  it('合并席位时被合并的候选人同样计入（P2-4：两个表达式落到同一接手人）', () => {
    expect(
      previousNodeComparand([
        { candidateUserId: 'subject', mergedCandidateUserIds: ['manager'] },
        { candidateUserId: 'b', mergedCandidateUserIds: [] },
        { candidateUserId: null, mergedCandidateUserIds: ['manager'] },
      ]),
    ).toEqual(['subject', 'manager', 'b']);
  });
  it('候选人按序去重，没有候选人的任务（转交、加签、撤回）不计', () => {
    expect(
      previousNodeComparand([
        { candidateUserId: 'a' },
        { candidateUserId: null },
        { candidateUserId: 'b' },
        { candidateUserId: 'a' },
      ]),
    ).toEqual(['a', 'b']);
  });
  it('解析出的审批人是上一节点任一候选人即按相同审批人处理', () => {
    const node = single({ sameAssigneeSkip: true });
    const previous = facts({ previousApproverUserIds: ['a', 'b'] });
    expect(decideNode(node, { userId: 'b', personId: null }, previous)).toMatchObject({
      kind: 'auto',
      outcome: 'same_skip',
    });
    expect(decideNode(node, { userId: 'c', personId: null }, previous)).toMatchObject({
      kind: 'assign',
      origin: 'resolved',
    });
  });
});
