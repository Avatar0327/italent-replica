import { describe, expect, it } from 'vitest';
import { validateRoutes, resolveSuccessor, exitFamily, ROUTE_END, type ExitRoute, type RouteBranch } from './routes.js';
import { APPROVAL_TYPES, type ApprovalNode } from './types.js';

const fields = APPROVAL_TYPES.transfer.conditionFields;
const DEPT = 'record.departmentId';

const node = (key: string, routes?: readonly ExitRoute[], extra: Record<string, unknown> = {}): ApprovalNode =>
  ({
    key,
    name: key,
    noAssignee: 'exception_admin',
    sameAssigneeSkip: false,
    historySameAssigneeSkip: false,
    sameAssigneeResult: 'approve',
    historySameAssigneeResult: 'approve',
    formFields: [],
    editableFields: [],
    editMode: 'none',
    actions: {},
    rejectCommentRequired: false,
    hideRecords: false,
    rejectResubmit: 'restart',
    messageRules: [],
    approver: { type: 'specified', value: 'u' },
    ...(routes ? { routes } : {}),
    ...extra,
  }) as unknown as ApprovalNode;

const when = (priority: number, operator: string, value: string | string[] | null, target: string): RouteBranch => ({
  kind: 'condition',
  priority,
  conditions: { items: [{ no: 1, field: DEPT, operator, value } as never], expression: '1' },
  target,
});
const otherwise = (target: string): RouteBranch => ({ kind: 'else', target });
const approve = (...branches: RouteBranch[]): ExitRoute => ({ exit: 'approve', branches });

const reasons = (nodes: ApprovalNode[]) => validateRoutes(nodes, fields).map((v) => v.reason);

describe('F-478 分支校验 validateRoutes', () => {
  it('没有 routes 的线性流程零违规；合法分支零违规', () => {
    expect(reasons([node('a'), node('b'), node('c')])).toEqual([]);
    const nodes = [node('a', [approve(when(1, 'in', ['x'], 'c'), otherwise('b'))]), node('b'), node('c')];
    expect(reasons(nodes)).toEqual([]);
  });

  it('目标只能指向更靠后的节点或 END：回指、指自己都拒绝', () => {
    const back = [node('a'), node('b', [approve({ kind: 'direct', target: 'a' })]), node('c')];
    expect(reasons(back)).toContain('backward_target');
    const self = [node('a', [approve({ kind: 'direct', target: 'a' })]), node('b')];
    expect(reasons(self)).toContain('self_target');
    expect(reasons([node('a', [approve({ kind: 'direct', target: 'zzz' })]), node('b')])).toContain('unknown_target');
  });

  it('条件分支必须有 Else；优先级不得重复；direct 不得与别的分支并存；Else 不能和 direct 同在', () => {
    expect(reasons([node('a', [approve(when(1, 'eq', 'x', 'b'))]), node('b')])).toContain('missing_else');
    expect(
      reasons([node('a', [approve(when(1, 'eq', 'x', 'b'), when(1, 'eq', 'y', 'b'), otherwise('b'))]), node('b')]),
    ).toContain('duplicate_priority');
    expect(reasons([node('a', [approve({ kind: 'direct', target: 'b' }, otherwise('b'))]), node('b')])).toContain(
      'direct_mixed',
    );
    const elseWithCondition: RouteBranch = {
      kind: 'else',
      conditions: { items: [{ no: 1, field: DEPT, operator: 'eq', value: 'x' } as never], expression: '1' },
      target: 'b',
    };
    expect(reasons([node('a', [approve(elseWithCondition)]), node('b')])).toContain('else_with_condition');
  });

  it('非首节点必须能被某条路径到达，否则不可达节点拒绝发布', () => {
    const nodes = [node('a', [approve({ kind: 'direct', target: 'c' })]), node('b'), node('c')];
    expect(validateRoutes(nodes, fields)).toContainEqual(
      expect.objectContaining({ reason: 'unreachable_node', nodeKey: 'b' }),
    );
  });

  it('条件字段不在白名单 / 条件非法 → unknown_field / invalid_condition', () => {
    const bad = (field: string) =>
      node('a', [
        approve(
          {
            kind: 'condition',
            priority: 1,
            conditions: { items: [{ no: 1, field, operator: 'eq', value: 'x' } as never], expression: '1' },
            target: 'b',
          },
          otherwise('b'),
        ),
      ]);
    expect(reasons([bad('no.such.field'), node('b')])).toContain('unknown_field');
    const invalid = node('a', [approve(when(1, 'in', 'not-a-list' as never, 'b'), otherwise('b'))]);
    expect(reasons([invalid, node('b')])).toContain('invalid_condition');
  });

  it('出口必须在节点出口集合内；会签节点不能用业务出口；业务出口须成对且本片未登记任何业务出口组', () => {
    expect(reasons([node('a', [{ exit: 'disagree', branches: [otherwise('END')] }]), node('b')])).toContain(
      'exit_not_on_node',
    );
    const countersign = node('a', undefined, { kind: 'countersign', exits: ['approve_no_rehire', 'approve_rehire'] });
    expect(reasons([countersign, node('b')])).toContain('countersign_business_exit');
    const lonely = node('a', undefined, { exits: ['approve_rehire'] });
    expect(reasons([lonely, node('b')])).toContain('incomplete_exit_group');
    const unregistered = node('a', undefined, { exits: ['approve_no_rehire', 'approve_rehire'] });
    expect(reasons([unregistered, node('b')])).toContain('business_exit_type');
  });

  it('单个出口最多 10 个分支', () => {
    const branches = Array.from({ length: 10 }, (_, i) => when(i + 1, 'eq', `d${i}`, 'b'));
    expect(reasons([node('a', [approve(...branches, otherwise('b'))]), node('b')])).toContain('too_many_branches');
  });

  it('违规带节点、出口、分支序号，供前端定位', () => {
    const [v] = validateRoutes([node('a'), node('b', [approve({ kind: 'direct', target: 'a' })])], fields);
    expect(v).toMatchObject({ reason: 'backward_target', nodeKey: 'b', exit: 'approve', branchNo: 1 });
  });
});

describe('F-478 后继解析 resolveSuccessor', () => {
  const ctx = (department: string | null) => ({
    values: department === null ? {} : { [DEPT]: department },
    orgAncestors: {},
  });
  const nodes = [
    node('a', [approve(when(2, 'in', ['d1', 'd2'], 'c'), when(1, 'eq', 'd1', 'd'), otherwise('b'))]),
    node('b'),
    node('c'),
    node('d'),
  ];

  it('无 routes：同意 → 下一个节点（末尾 END），不同意 → END', () => {
    const linear = [node('a'), node('b')];
    expect(resolveSuccessor(linear, 'a', 'approve', ctx('x'))).toEqual({ target: 'b', branchNo: null });
    expect(resolveSuccessor(linear, 'b', 'approve', ctx('x'))).toEqual({ target: ROUTE_END, branchNo: null });
    expect(resolveSuccessor(linear, 'a', 'disagree', ctx('x'))).toEqual({ target: ROUTE_END, branchNo: null });
  });

  it('多条命中取优先级数值小的；都不命中走 Else', () => {
    expect(resolveSuccessor(nodes, 'a', 'approve', ctx('d1'))).toMatchObject({ target: 'd', branchNo: 2 });
    expect(resolveSuccessor(nodes, 'a', 'approve', ctx('d2'))).toMatchObject({ target: 'c', branchNo: 1 });
    expect(resolveSuccessor(nodes, 'a', 'approve', ctx('d9'))).toMatchObject({ target: 'b', branchNo: 3 });
  });

  it('not_in 对空值为真（沿用发起条件口径）', () => {
    const list = [node('a', [approve(when(1, 'not_in', ['d1'], 'c'), otherwise('b'))]), node('b'), node('c')];
    expect(resolveSuccessor(list, 'a', 'approve', ctx(null))).toMatchObject({ target: 'c' });
    expect(resolveSuccessor(list, 'a', 'approve', ctx('d1'))).toMatchObject({ target: 'b' });
  });

  it('已配置的不同意出口可以去往后续节点；未配置的不同意出口结束', () => {
    const withDisagree = [
      node('a', [{ exit: 'disagree', branches: [{ kind: 'direct', target: 'c' }] }], {
        exits: ['approve', 'disagree'],
      }),
      node('b'),
      node('c'),
    ];
    expect(resolveSuccessor(withDisagree, 'a', 'disagree', ctx('x'))).toMatchObject({ target: 'c' });
    expect(resolveSuccessor(withDisagree, 'a', 'approve', ctx('x'))).toMatchObject({ target: 'b' });
  });

  it('业务出口按同意族 / 不同意族归类', () => {
    expect(exitFamily('approve')).toBe('approve');
    expect(exitFamily('approve_rehire')).toBe('approve');
    expect(exitFamily('approve_no_rehire')).toBe('approve');
    expect(exitFamily('disagree')).toBe('disagree');
  });
});
