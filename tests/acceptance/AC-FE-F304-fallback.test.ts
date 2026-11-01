import { describe, expect, it } from 'vitest';
import { approverSource, HANDOVER_FALLBACK_LIMIT } from '@italent/domain';
import {
  buildDraft,
  editableValues,
  nodeField,
  assertDraftStructure,
} from '../../apps/web/src/approval/designer/model.js';
import { fallbackFixture } from './support/f304-fixture.js';

const id = 'a3000000-0000-4000-8000-000000000001';
describe('AC-FE-F304 兜底属性进入既有表单内核', () => {
  it('01 两类会签交接字段回填、增删保存；其他字段保持原样', () => {
    const flow = fallbackFixture();
    for (const key of ['work_handover', 'other_handover']) {
      const field = nodeField(key, 'fallbackUserIds');
      expect(editableValues(flow.latestVersion, flow.approvalType)[field]).toEqual([]);
      const next = buildDraft(flow.latestVersion, { [field]: [id] }, flow.approvalType);
      expect(next.nodes.find((node) => node.key === key)?.fallbackUserIds).toEqual([id]);
      expect(next.conditions).toEqual(flow.latestVersion.conditions);
      expect(
        buildDraft({ ...flow.latestVersion, ...next }, { [field]: [] }, flow.approvalType).nodes.find(
          (node) => node.key === key,
        )?.fallbackUserIds,
      ).toEqual([]);
    }
  });
  it('02 重复、超限、非交接节点和非离职交接类型不可编辑', () => {
    const flow = fallbackFixture();
    const field = nodeField('work_handover', 'fallbackUserIds');
    for (const value of [[id, id], Array(HANDOVER_FALLBACK_LIMIT + 1).fill(id), ['invalid']])
      expect(() => buildDraft(flow.latestVersion, { [field]: value }, flow.approvalType)).toThrow();
    expect(() => buildDraft(flow.latestVersion, { [field]: [id] }, 'transfer')).toThrow();
    expect(editableValues(flow.latestVersion, 'transfer')).not.toHaveProperty(field);
    expect(editableValues(flow.latestVersion, flow.approvalType)).not.toHaveProperty(
      nodeField('employee_confirm', 'fallbackUserIds'),
    );
  });
  it('03 冲突重读保留其他节点新属性；节点结构改变仍拦截', () => {
    const flow = fallbackFixture();
    const latest = structuredClone(flow.latestVersion);
    Object.assign(latest.nodes[1]!, { name: '其他人改名' });
    assertDraftStructure(flow.latestVersion, latest);
    const body = buildDraft(latest, { [nodeField('work_handover', 'fallbackUserIds')]: [id] }, flow.approvalType);
    expect(body.nodes[1]?.name).toBe('其他人改名');
    expect(() => assertDraftStructure(flow.latestVersion, { ...latest, nodes: latest.nodes.slice(1) })).toThrow();
    Object.assign(latest.nodes[0]!, { approvers: [approverSource('direct_manager')] });
    expect(() => assertDraftStructure(flow.latestVersion, latest)).toThrow();
  });
  it('04 F-318a 来源类型和值共同决定兜底资格，空人来源与兜底人员独立保留', () => {
    const flow = fallbackFixture();
    const original = flow.latestVersion;
    const field = nodeField('work_handover', 'fallbackUserIds');
    const emptyApproverSources = [{ type: 'specified', value: id }];
    Object.assign(original.nodes[0]!, { emptyApproverPolicy: 'specified', emptyApproverSources });
    const latest = structuredClone(original);
    expect(() => assertDraftStructure(original, latest)).not.toThrow();
    expect(buildDraft(latest, { [field]: [id] }, flow.approvalType).nodes[0]).toMatchObject({
      emptyApproverPolicy: 'specified',
      emptyApproverSources,
      fallbackUserIds: [id],
    });
    Object.assign(latest.nodes[0]!, {
      approvers: [{ type: 'custom_variable', value: 'handover_work_owner' }],
    });
    expect(editableValues(latest, flow.approvalType)).not.toHaveProperty(field);
    expect(() => assertDraftStructure(original, latest)).toThrow();
  });
});
