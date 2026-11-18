/**
 * AC-APV-F478-26 设计器模型层（F-478 S7，设计 §1.4、§2.2、§5）：新来源取值名称、节点出口分支进入表单内核的可编辑值、
 * 草稿载荷按 S2 契约回带 routes（列表值仍为数组、空出口不发、显式清空发 []），读回形状不完整时只读。合成数据。
 */
import { describe, expect, it } from 'vitest';
import type { ExitRoute } from '@italent/domain';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { buildDraft, completeDefinition, editableValues, nodeField } from './model.js';
import { sourceOptions } from './sources.js';

/** 三节点 manager → hr → final（合成）；routes 按节点 key 给出读回的出口分支。 */
function threeNodes(routes: Record<string, unknown> = {}) {
  const { latestVersion } = flowFixture();
  const [manager, hr] = latestVersion.nodes;
  const nodes = [manager!, hr!, { ...structuredClone(hr!), key: 'final', name: '合成末审' }];
  return {
    ...latestVersion,
    nodes: nodes.map((node) => (node.key in routes ? { ...node, routes: routes[node.key] as ExitRoute[] } : node)),
  };
}
const saved: ExitRoute[] = [
  {
    exit: 'approve',
    branches: [
      {
        kind: 'condition',
        priority: 1,
        conditions: {
          expression: '1',
          items: [{ no: 1, field: 'business.kind', operator: 'in', value: ['合成甲类', '合成乙类'] }],
        },
        target: 'final',
      },
      { kind: 'else', target: 'hr' },
    ],
  },
];
const routesOf = (key: string) => nodeField(key, 'routes');

describe('AC-APV-F478-26 新来源在来源选择中有名称', () => {
  it('本对象字段下有“主体员工本人”，身份的固定取值有“系统管理员”', () => {
    const options = sourceOptions(threeNodes().nodes[0]!, 'transfer');
    const label = (type: string, value: string) =>
      options.find((option) => option.value === type)?.children.find((child) => child.value === value)?.label;
    expect(label('object_field', 'subject_employee')).toBe('主体员工本人');
    expect(label('identity', 'system_admin')).toBe('系统管理员');
  });

  it('退休返聘后来源有名称（仅退休类型可选，名称与可选性分开）', () => {
    const options = sourceOptions(threeNodes().nodes[0]!, 'retirement');
    const child = (type: string, value: string) =>
      options.find((option) => option.value === type)?.children.find((item) => item.value === value);
    expect(child('object_field', 'rehire_direct_manager')?.label).toBe('返聘后直线经理');
    expect(child('department', 'rehire_department_hrbp')?.label).toBe('返聘后 HRBP');
  });
});

describe('AC-APV-F478-26 出口分支进入可编辑值并按契约提交', () => {
  it('每个节点都有 routes 可编辑值：已配置的按读回原样，未配置为空列表', () => {
    const version = threeNodes({ manager: saved });
    const values = editableValues(version, 'transfer');
    expect(values[routesOf('manager')]).toEqual(saved);
    expect(values[routesOf('hr')]).toEqual([]);
    expect(values[routesOf('final')]).toEqual([]);
  });

  it('编辑后的分支：条件项按顺序编号、列表值仍为数组；Else 不带优先级与条件；没有分支的出口不发送', () => {
    const version = threeNodes();
    const edited = {
      [routesOf('manager')]: [
        {
          exit: 'approve',
          branches: [
            {
              kind: 'condition',
              priority: 3,
              conditions: {
                expression: ' ',
                items: [
                  { no: 7, field: 'business.kind', operator: 'in', value: ['合成甲类', '合成乙类'] },
                  { no: 9, field: 'employee.code', operator: 'not_empty', value: null },
                ],
              },
              target: 'final',
            },
            { kind: 'else', priority: 4, conditions: { expression: '', items: [] }, target: 'hr' },
          ],
        },
        { exit: 'disagree', branches: [] },
      ],
    };
    const draft = buildDraft(version, edited, 'transfer');
    expect(draft.nodes[0]!.routes).toEqual([
      {
        exit: 'approve',
        branches: [
          {
            kind: 'condition',
            priority: 3,
            conditions: {
              expression: '',
              items: [
                { no: 1, field: 'business.kind', operator: 'in', value: ['合成甲类', '合成乙类'] },
                { no: 2, field: 'employee.code', operator: 'not_empty', value: null },
              ],
            },
            target: 'final',
          },
          { kind: 'else', target: 'hr' },
        ],
      },
    ]);
  });

  it('清空全部分支发送 routes: []（服务端按显式清空处理）；未编辑的节点原样回带读回的分支', () => {
    const version = threeNodes({ hr: [{ exit: 'approve', branches: [{ kind: 'direct', target: 'END' }] }] });
    const draft = buildDraft(version, { [routesOf('manager')]: [] }, 'transfer');
    expect(draft.nodes[0]!.routes).toEqual([]);
    expect(draft.nodes[1]!.routes).toEqual([{ exit: 'approve', branches: [{ kind: 'direct', target: 'END' }] }]);
  });

  it('未选去向、条件项未选字段或运算符：本地拦截并指出出口与分支，不发请求', () => {
    const version = threeNodes();
    const noTarget = [{ exit: 'approve', branches: [{ kind: 'else', target: '' }] }];
    expect(() => buildDraft(version, { [routesOf('manager')]: noTarget }, 'transfer')).toThrow(
      '同意 · 分支 1：请选择去向',
    );
    const noOperator = [
      {
        exit: 'approve',
        branches: [
          {
            kind: 'condition',
            priority: 1,
            conditions: { expression: '', items: [{ no: 1, field: 'business.kind', operator: '', value: '' }] },
            target: 'final',
          },
          { kind: 'else', target: 'hr' },
        ],
      },
    ];
    expect(() => buildDraft(version, { [routesOf('manager')]: noOperator }, 'transfer')).toThrow(
      '同意 · 分支 1：请选择条件字段和运算符',
    );
  });
});

describe('AC-APV-F478-26 读回的分支形状不完整时只读', () => {
  it('合法读回可编辑；分支缺去向或条件项形状错误时 completeDefinition 为 false', () => {
    const version = threeNodes({ manager: saved });
    expect(completeDefinition(version)).toBe(true);
    for (const broken of [
      [{ exit: 'approve', branches: [{ kind: 'else' }] }],
      [{ exit: 'approve', branches: [{ kind: 'condition', priority: 1, target: 'hr' }] }],
      [{ exit: 'approve', branches: [{ kind: 'loop', target: 'hr' }] }],
      [{ exit: 1, branches: [] }],
      { exit: 'approve' },
    ]) {
      const bad = threeNodes({ manager: broken });
      expect(completeDefinition(bad), JSON.stringify(broken)).toBe(false);
    }
  });
});
