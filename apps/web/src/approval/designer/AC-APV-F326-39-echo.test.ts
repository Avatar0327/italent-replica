/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-APV-F326-39（F-326 S7b，主设计 §5.5 ④⑦、F-326-L §5.5）设计器回显：
 * 读视图里本位置自动变量（public_variable + autoVariable）回显为“指定人员”，标编码、停用提示、引用流程数、
 * 待生效人员“发布后生效”；其他流程的自动变量照公共变量显示；查重时未选人占位不参与。
 * 读视图形状照 apps/api enrichProcessView（AutoVariableView），合成 ID。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Form } from 'antd';
import type { ApprovalNode, ApproverSource } from '@italent/domain';
import { act, h, uiHarness } from '../../../../../tests/acceptance/support/f474-ui.js';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { ApproverSources } from './ApproverSources.js';
import { buildDraft, editableValues, nodeField } from './model.js';
import { sourceInputError } from './sources.js';
import type { VersionView } from './model.js';

const A = 'b3290000-0000-4000-8000-0000000000a1';
const B = 'b3290000-0000-4000-8000-0000000000b2';
const X = 'b3290000-0000-4000-8000-000000000101';
const Y = 'b3290000-0000-4000-8000-000000000102';
const OTHER = 'b3290000-0000-4000-8000-000000000103';
const PEOPLE = '/api/tenant/approval/designer/person-candidates';
const NAMES: Record<string, string> = { [A]: '合成甲', [B]: '合成乙' };
const people = (url: URL) => ({
  items: (url.searchParams.get('userIds') ?? '')
    .split(',')
    .filter((id) => NAMES[id])
    .map((userId) => ({ userId, name: NAMES[userId], code: null, departmentName: null })),
  hasMore: false,
});
type Auto = Record<string, unknown>;
const auto = (id: string, extra: Auto = {}) =>
  ({
    type: 'public_variable',
    value: id,
    autoVariable: { id, code: `Global.B.SynthAuto${id.slice(-1)}`, status: 'enabled', revision: 2, ...extra },
  }) as unknown as ApproverSource;
const template = flowFixture().latestVersion.nodes[0]!;
const single = (approver: ApproverSource, extra: Partial<ApprovalNode> = {}) =>
  ({ ...template, approver, ...extra }) as unknown as ApprovalNode;
const countersign = (approvers: ApproverSource[], extra: Partial<ApprovalNode> = {}) => {
  const { approver: _approver, ...rest } = template as unknown as Record<string, unknown>;
  return { ...rest, kind: 'countersign', approvers, transitionRule: { type: 'all', rules: {} }, ...extra } as never;
};
const versionOf = (...nodes: ApprovalNode[]) =>
  ({ ...flowFixture().latestVersion, nodes: nodes.map((node, i) => ({ ...node, key: `n${i}` })) }) as VersionView;

let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

async function show(node: ApprovalNode, empty = false) {
  const version = versionOf(node);
  const shown = version.nodes[0]!;
  const Harness = () => {
    const [form] = Form.useForm();
    return h(
      Form,
      { form, initialValues: editableValues(version, 'transfer') },
      h(ApproverSources, { node: shown, approvalType: 'transfer', empty }),
    );
  };
  await ui.render(h(Harness, {}), '/', undefined, { [PEOPLE]: people });
  await settle();
  await settle();
  return ui.host.textContent ?? '';
}

it('AC-APV-F326-39-01 本位置自动变量回显为指定人员：单人节点有人 / 未选人；会签、审批人为空各位置逐人成行', () => {
  const version = versionOf(
    single(auto(X, { userIds: [A], referencingProcessCount: 1 })),
    single(auto(Y, { userIds: null, referencingProcessCount: 1 })),
    countersign([auto(X, { userIds: [A, B], referencingProcessCount: 1 }), { type: 'object_field', value: 'x' }], {
      emptyApproverPolicy: 'specified',
      emptyApproverSources: [auto(Y, { userIds: null, referencingProcessCount: 1 })],
    }),
  );
  const values = editableValues(version, 'transfer');
  expect(values[nodeField('n0', 'approver')]).toEqual({ type: 'specified', value: A });
  expect(values[nodeField('n1', 'approver')]).toEqual({ type: 'specified', value: '' });
  expect(values[nodeField('n2', 'approvers')]).toEqual([
    { type: 'specified', value: A },
    { type: 'specified', value: B },
    { type: 'object_field', value: 'x' },
  ]);
  expect(values[nodeField('n2', 'emptyApproverSources')]).toEqual([{ type: 'specified', value: '' }]);
});

it('AC-APV-F326-39-02 有待生效人员时回显待生效值；其他流程的自动变量（无 autoVariable）仍是公共变量', () => {
  const version = versionOf(
    single(auto(X, { userIds: [A], pendingUserIds: [B], referencingProcessCount: 1 })),
    single({ type: 'public_variable', value: OTHER }),
  );
  const values = editableValues(version, 'transfer');
  expect(values[nodeField('n0', 'approver')]).toEqual({ type: 'specified', value: B });
  expect(values[nodeField('n1', 'approver')]).toEqual({ type: 'public_variable', value: OTHER });
});

it('AC-APV-F326-39-03 保存时未编辑的节点也按指定人员提交，不回传 autoVariable 与变量引用', () => {
  const version = versionOf(
    single(auto(X, { userIds: [A], referencingProcessCount: 1 })),
    single(auto(Y, { userIds: null, status: 'disabled', referencingProcessCount: 1 })),
  );
  const draft = buildDraft(version, {}, 'transfer');
  expect(draft.nodes.map((node) => (node as { approver: ApproverSource }).approver)).toEqual([
    { type: 'specified', value: A },
    { type: 'specified', value: '' },
  ]);
  expect(JSON.stringify(draft)).not.toContain('autoVariable');
});

it('AC-APV-F326-39-04 查重：多个未选人占位不算重复（同主设计 ② 前置校验第 4 项），真实人员重复仍拦下', () => {
  const node = countersign([]);
  const blank = { type: 'specified', value: '' } as const;
  expect(sourceInputError([blank, blank], node, 'transfer')).toBeUndefined();
  expect(sourceInputError([blank, blank], node, 'transfer', true)).toBeUndefined();
  expect(
    sourceInputError(
      [
        { type: 'specified', value: A },
        { type: 'specified', value: A },
      ],
      node,
      'transfer',
    ),
  ).toBe('审批人来源不能重复');
});

it('AC-APV-F326-39-05 回显：指定人员 + 小字编码 + 引用 1 个流程（非提示色）', async () => {
  const text = await show(single(auto(X, { userIds: [A], referencingProcessCount: 1 })));
  expect(text).toContain('指定人员：合成甲');
  expect(ui.host.querySelector('.flow-auto-code')?.textContent).toBe('Global.B.SynthAuto1');
  expect(text).toContain('该变量被 1 个流程引用');
  expect(ui.host.querySelector('.flow-auto-usage.ant-typography-warning')).toBeNull();
});

it('AC-APV-F326-39-06 默认值为空显示“未选择”；引用 ≥ 2 个流程用提示色', async () => {
  const text = await show(single(auto(Y, { userIds: null, referencingProcessCount: 3 })));
  expect(text).toContain('指定人员：未选择');
  expect(text).toContain('该变量被 3 个流程引用');
  expect(ui.host.querySelector('.flow-auto-usage.ant-typography-warning')).not.toBeNull();
});

it('AC-APV-F326-39-07 变量已停用：标“已停用”并提示保存后重新生成', async () => {
  const text = await show(single(auto(X, { userIds: [A], status: 'disabled', referencingProcessCount: 1 })));
  expect(text).toContain('已停用');
  expect(text).toContain('保存后将按所列人员重新生成');
});

it('AC-APV-F326-39-08 待生效值：显示待生效人员并标“发布后生效”；审批人为空位置同样回显', async () => {
  const node = single(auto(X, { userIds: [A], pendingUserIds: [B], referencingProcessCount: 1 }), {
    emptyApproverPolicy: 'specified',
    emptyApproverSources: [auto(Y, { userIds: [A], referencingProcessCount: 2 })],
  });
  const text = await show(node);
  expect(text).toContain('指定人员：合成乙');
  expect(text).toContain('发布后生效');
  await ui.close();
  ui = uiHarness();
  const empty = await show(node, true);
  expect(empty).toContain('指定人员：合成甲');
  expect(empty).toContain('Global.B.SynthAuto2');
  expect(empty).not.toContain('发布后生效');
});

it('AC-APV-F326-39-09 其他流程的自动变量（无 autoVariable）不显示指定人员摘要与引用数', async () => {
  const text = await show(single({ type: 'public_variable', value: OTHER }));
  expect(text).not.toContain('指定人员：');
  expect(text).not.toContain('个流程引用');
});
