import { describe, expect, it } from 'vitest';
import { conditionViolations, evaluateCondition } from './conditions.js';
import { publishViolations } from './definition.js';
import { PRESET_PROCESSES } from './presets.js';
import { decideNode, type Candidate, type RoutingFacts } from './routing.js';
import { APPROVAL_TYPES, type ApprovalNode, type ConditionItem } from './types.js';

const fields = APPROVAL_TYPES.transfer.conditionFields;
const item = (no: number, field: string, operator: ConditionItem['operator'], value: ConditionItem['value']) => ({
  no,
  field,
  operator,
  value,
});

describe('发起条件（`14` §1.1）', () => {
  const context = {
    values: { processCode: 'TransferProcessNew', 'before.departmentId': 'child', 'employee.name': '甲' },
    orgAncestors: { child: ['child', 'parent', 'root'] },
  };
  it('高级表达式支持 and / or / not / 括号，默认全部 AND', () => {
    const items = [
      item(1, 'processCode', 'eq', 'TransferProcessNew'),
      item(2, 'before.departmentId', 'in_org_tree', 'parent'),
      item(3, 'employee.name', 'eq', '乙'),
    ];
    expect(evaluateCondition({ items, expression: '' }, context).result).toBe(false);
    expect(evaluateCondition({ items, expression: '1 and (2 or 3)' }, context).result).toBe(true);
    expect(evaluateCondition({ items, expression: '1 AND NOT 3' }, context).result).toBe(true);
    expect(evaluateCondition({ items: [], expression: '' }, context).result).toBe(true);
  });
  it('值列表、为空判断与包含下级只对组织字段开放', () => {
    expect(
      evaluateCondition({ items: [item(1, 'employee.code', 'is_empty', null)], expression: '' }, context).result,
    ).toBe(true);
    expect(
      evaluateCondition({ items: [item(1, 'employee.name', 'in', ['甲', '丙'])], expression: '' }, context).result,
    ).toBe(true);
    expect(
      conditionViolations({ items: [item(1, 'employee.name', 'in_org_tree', 'x')], expression: '' }, fields),
    ).toHaveLength(1);
    expect(
      conditionViolations({ items: [item(1, 'employee.salary', 'eq', '1')], expression: '' }, fields),
    ).toHaveLength(1);
    expect(conditionViolations({ items: [item(1, 'processCode', 'eq', 'A')], expression: '1 and 2' }, fields)).toEqual([
      '高级表达式不合法或引用了不存在的条件编号',
    ]);
  });
});

const node = (extra: Partial<ApprovalNode> = {}): ApprovalNode => ({
  key: 'n',
  name: '节点',
  approver: 'record_department_head',
  noAssignee: 'exception_admin',
  sameAssigneeSkip: true,
  historySameAssigneeSkip: true,
  formFields: [],
  editableFields: [],
  editMode: 'none',
  actions: { transfer: false, addSign: false, urge: true },
  rejectCommentRequired: false,
  rejectResubmit: 'restart',
  messageRules: [],
  ...extra,
});
const facts = (extra: Partial<RoutingFacts> = {}): RoutingFacts => ({
  isFirstNode: false,
  initiatorUserId: 'initiator',
  subjectEmployeeId: 'subject-person',
  subjectUserId: 'subject-user',
  exceptionAdminUserId: 'admin',
  previousApproverUserId: null,
  approvedUserIds: [],
  chainUserIds: [],
  ...extra,
});
const person = (userId: string | null, personId: string | null = null): Candidate => ({ userId, personId });

describe('节点审批人决策（DEC-054 / DEC-068）', () => {
  it('首节点为空报错；中间节点按配置转异常管理员 / 跳过 / 同意', () => {
    expect(decideNode(node(), person(null), facts({ isFirstNode: true })).kind).toBe('first_node_empty');
    expect(decideNode(node(), person(null), facts())).toMatchObject({
      kind: 'assign',
      userId: 'admin',
      isExceptionAdmin: true,
    });
    expect(decideNode(node({ noAssignee: 'skip' }), person(null), facts())).toMatchObject({
      outcome: 'no_assignee_skip',
    });
    expect(decideNode(node({ noAssignee: 'approve' }), person(null), facts())).toMatchObject({
      outcome: 'no_assignee_approve',
    });
  });
  it('自审优先于相同审批人跳过：转直线经理；经理为空 / 本人 / 已在链上转异常管理员', () => {
    const self = person('initiator');
    const previous = facts({ previousApproverUserId: 'initiator' });
    expect(decideNode(node(), self, previous, person('boss'))).toMatchObject({
      origin: 'self_skip_manager',
      userId: 'boss',
      selfSkippedUserId: 'initiator',
    });
    expect(decideNode(node(), self, previous)).toMatchObject({ origin: 'exception_admin' });
    expect(decideNode(node(), person('x', 'subject-person'), facts(), person('subject-user'))).toMatchObject({
      origin: 'exception_admin',
    });
    expect(decideNode(node(), self, facts({ chainUserIds: ['boss'] }), person('boss'))).toMatchObject({
      origin: 'exception_admin',
    });
  });
  it('相同 / 历史相同审批人跳过（结果 = 同意）', () => {
    expect(decideNode(node(), person('a'), facts({ previousApproverUserId: 'a' }))).toMatchObject({
      outcome: 'same_skip',
    });
    expect(decideNode(node(), person('a'), facts({ approvedUserIds: ['a'] }))).toMatchObject({
      outcome: 'history_skip',
    });
    expect(
      decideNode(
        node({ sameAssigneeSkip: false, historySameAssigneeSkip: false }),
        person('a'),
        facts({ approvedUserIds: ['a'] }),
      ),
    ).toMatchObject({ kind: 'assign', origin: 'resolved' });
  });
});

describe('发布校验与出厂预置（DEC-018 / DEC-054）', () => {
  it('预置调动流程带流程编码条件，未配异常管理员不能发布', () => {
    const preset = PRESET_PROCESSES[0]!;
    expect(preset.definition.conditions.items).toHaveLength(1);
    expect(publishViolations(preset.definition).map((v) => v.reason)).toEqual(['APPROVAL_EXCEPTION_ADMIN_REQUIRED']);
    expect(
      publishViolations({
        ...preset.definition,
        exceptionAdminUserId: 'admin',
        conditions: { items: [], expression: '' },
      }),
    ).toMatchObject([{ reason: 'APPROVAL_CONDITION_REQUIRED' }]);
  });
});
