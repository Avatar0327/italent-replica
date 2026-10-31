import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TYPES,
  APPROVER_SOURCE_TYPES,
  exitRulesOf,
  approverSourceViolations,
  type ApproverSource,
} from '@italent/domain';
import { flowFixture } from '../../../../../tests/acceptance/support/f315-fixture.js';
import { fallbackFixture } from '../../../../../tests/acceptance/support/f304-fixture.js';
import {
  buildDraft,
  completeDefinition,
  editableValues,
  nodeField,
  acceptProcessReceipt,
  assertDraftStructure,
} from './model.js';
import { ApiError } from '../../foundation/client.js';
import { createFormStore, isLocked } from '../../foundation/forms/store.js';

const person: ApproverSource = { type: 'specified', value: 'a3000000-0000-4000-8000-000000000003' };
const previous: ApproverSource = { type: 'context_variable', value: 'previous_approved' };
const field = nodeField('manager', 'approver');

describe('AC-FE-F318b 来源级联', () => {
  it('01 单人来源进入编辑投影，按类型和值保存；拒绝多条和伪造字段', () => {
    const flow = flowFixture();
    expect(editableValues(flow.latestVersion, 'transfer')[field]).toEqual({
      type: 'object_field',
      value: 'direct_manager',
    });
    expect(buildDraft(flow.latestVersion, { [field]: previous }, 'transfer').nodes[0]).toMatchObject({
      approver: previous,
    });
    expect(() => buildDraft(flow.latestVersion, { [field]: [person, previous] }, 'transfer')).toThrow();
    expect(() =>
      buildDraft(flow.latestVersion, { [nodeField('manager', 'approvers')]: [person] }, 'transfer'),
    ).toThrow();
  });
  it('02 会签多条和空人来源独立保存，不覆盖 fallback 或 F-316 策略', () => {
    const flow = fallbackFixture();
    Object.assign(flow.latestVersion.nodes[0]!, { emptyApproverPolicy: 'specified', fallbackUserIds: [person.value] });
    const main = nodeField('work_handover', 'approvers');
    const empty = nodeField('work_handover', 'emptyApproverSources');
    expect(editableValues(flow.latestVersion, flow.approvalType)[empty]).toEqual([]);
    const body = buildDraft(flow.latestVersion, { [main]: [previous, person], [empty]: [person] }, flow.approvalType);
    expect(body.nodes[0]).toMatchObject({
      approvers: [previous, person],
      emptyApproverSources: [person],
      emptyApproverPolicy: 'specified',
      fallbackUserIds: [person.value],
    });
    expect(body.nodes[1]).toEqual(flow.latestVersion.nodes[1]);
    expect(() => buildDraft(flow.latestVersion, { [main]: [person, person] }, flow.approvalType)).toThrow();
    expect(() => buildDraft(flow.latestVersion, { [main]: [] }, flow.approvalType)).toThrow();
    Object.assign(flow.latestVersion.nodes[0]!, { emptyApproverPolicy: 'stop' });
    expect(() => buildDraft(flow.latestVersion, { [empty]: [person] }, flow.approvalType)).toThrow();
  });
  it('03 15 类按契约顺序，F-326 灰显，F-318c 新值待开放，切类型清空旧值', async () => {
    const { sourceOptions, changeSourceType } = await import('./sources.js');
    const node = flowFixture().latestVersion.nodes[0]!;
    const options = sourceOptions(node, 'transfer');
    expect(options.map((o) => o.value)).toEqual(APPROVER_SOURCE_TYPES);
    for (const type of ['public_variable', 'application_variable', 'matrix'])
      expect(options.find((o) => o.value === type)).toMatchObject({ disabled: true, status: 'unsupported' });
    for (const type of ['business_org', 'profit_center', 'reserve4', 'reserve5', 'position', 'job', 'identity'])
      expect(options.find((o) => o.value === type)).toMatchObject({ disabled: true, status: 'pending' });
    expect(
      options.find((o) => o.value === 'department')?.children.some((o) => o.disabled && o.status === 'pending'),
    ).toBe(true);
    expect(changeSourceType(person, 'department')).toEqual({ type: 'department', value: '' });
  });
  it('04 每种审批类型的值与服务端同一校验，交接 / IDP / Offer / lookup 不放宽', async () => {
    const { sourceOptions } = await import('./sources.js');
    const node = flowFixture().latestVersion.nodes[0]!;
    for (const [code, type] of Object.entries(APPROVAL_TYPES)) {
      for (const option of sourceOptions(node, code)) {
        for (const value of option.children.filter((item) => !item.disabled)) {
          expect(
            approverSourceViolations(
              { ...node, kind: 'single', approver: { type: option.value, value: value.value } },
              type,
            ),
            `${code}/${value.value}`,
          ).toEqual([]);
        }
      }
    }
    const enabled = (code: string) =>
      sourceOptions(node, code).flatMap((o) => o.children.filter((v) => !v.disabled).map((v) => v.value));
    expect(enabled('transfer')).toContain('business_record_direct_manager');
    expect(enabled('transfer')).not.toContain('handover_hr_admin');
    expect(enabled('exit_handover')).toContain('handover_hr_admin');
    expect(enabled('offer')).not.toContain('business_record_direct_manager');
    expect(enabled('offer')).not.toContain('direct_manager');
    expect(() =>
      buildDraft(
        flowFixture().latestVersion,
        { [field]: { type: 'identity', value: 'handover_hr_admin' } },
        'transfer',
      ),
    ).toThrow();
  });
  it('05 不完整空人来源回执拒绝，指定人员和真实来源对象可读', () => {
    const flow = flowFixture();
    Object.assign(flow.latestVersion.nodes[0]!, { emptyApproverSources: ['legacy'] });
    expect(completeDefinition(flow.latestVersion)).toBe(false);
    expect(() => acceptProcessReceipt(flow, flow.id, 3)).toThrow();
    Object.assign(flow.latestVersion.nodes[0]!, { emptyApproverSources: [person] });
    expect(completeDefinition(flow.latestVersion)).toBe(true);
  });
  it('06 409 重读保留我的来源，未编辑配置取最新；未知锁住原命令；422 可修改', async () => {
    const flow = flowFixture();
    const baseline = editableValues(flow.latestVersion, 'transfer');
    expect(baseline).toHaveProperty(field);
    const store = createFormStore();
    const input = {
      baseline,
      values: { ...baseline, [field]: person },
      editableFields: Object.keys(baseline),
      revision: 4,
      businessId: flow.id,
      patchOnly: true,
      send: async () => {
        throw new ApiError(409, 'REVISION_CONFLICT', 'conflict', '版本冲突');
      },
    };
    await store.submit('flow', input);
    const latest = structuredClone(flow.latestVersion);
    Object.assign(latest.nodes[1]!, { name: '合成新名称' });
    await store.reread('flow', async () => ({ id: flow.id, revision: 5, values: editableValues(latest, 'transfer') }));
    store.confirm('flow');
    expect(store.get('flow')?.values[field]).toEqual(person);
    expect(buildDraft(latest, { [field]: person }, 'transfer').nodes[1]?.name).toBe('合成新名称');
    await store.submit('unknown', {
      ...input,
      send: async () => {
        throw new Error('network');
      },
    });
    const command = store.get('unknown')?.command?.id;
    expect(command).toBeTruthy();
    store.clear('unknown');
    expect(isLocked(store.get('unknown'))).toBe(true);
    await store.submit('unknown', { ...input, values: baseline });
    expect(store.get('unknown')?.command?.id).toBe(command);
    await store.submit('rejected', {
      ...input,
      send: async () => {
        throw new ApiError(422, 'APPROVAL_SOURCE_INVALID', 'fields', '审批人来源无效');
      },
    });
    expect(store.get('rejected')?.values[field]).toEqual(person);
    expect(isLocked(store.get('rejected'))).toBe(false);
  });
  it('13 409 空人策略改变时拦截恢复，避免静默丢掉已编辑来源', () => {
    const original = fallbackFixture().latestVersion;
    Object.assign(original.nodes[0]!, { emptyApproverPolicy: 'specified', emptyApproverSources: [person] });
    const latest = structuredClone(original);
    Object.assign(latest.nodes[0]!, { emptyApproverPolicy: 'stop', emptyApproverSources: [] });
    expect(() => assertDraftStructure(original, latest)).toThrow('流程版本或节点结构已变更');
  });
  it('14 保存载荷符合真实后端解析，101 个指定来源不在客户端截断', async () => {
    const { definitionSchema, toDefinition } = await import('../../../../api/src/modules/approval/definition-input.js');
    const flow = fallbackFixture();
    Object.assign(flow.latestVersion.nodes[0]!, { emptyApproverPolicy: 'specified' });
    for (const node of flow.latestVersion.nodes)
      if (node.kind === 'countersign')
        Object.assign(node, {
          transitionRule: {
            ...node.transitionRule,
            rules: exitRulesOf(node.transitionRule, node.exits ?? ['approve']),
          },
        });
    const sources = Array.from({ length: 101 }, (_, i) => ({
      type: 'specified',
      value: `a6000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    }));
    const body = buildDraft(
      flow.latestVersion,
      {
        [nodeField('work_handover', 'approvers')]: sources,
        [nodeField('work_handover', 'emptyApproverSources')]: [person],
      },
      flow.approvalType,
    );
    expect(toDefinition(definitionSchema.parse(body), 'exit_handover')).toEqual(body);
    expect(body.nodes[0]).toMatchObject({ approvers: sources, emptyApproverSources: [person] });
  });
  it('15 F-326 / F-318c 伪造值与未知审批类型不能提交；无权保持只读', async () => {
    const { editAccess } = await import('./model.js');
    const { flowPermission } = await import('../../../../../tests/acceptance/support/f315-fixture.js');
    const flow = flowFixture();
    for (const type of ['public_variable', 'application_variable', 'matrix', 'department', 'job']) {
      expect(() => buildDraft(flow.latestVersion, { [field]: { type, value: 'new-value' } }, 'transfer')).toThrow();
    }
    expect(() => buildDraft(flow.latestVersion, { [field]: person }, 'unknown')).toThrow();
    expect(editAccess({ ...flowPermission, editableFields: [] }, true, 'update')).toBe(false);
    expect(editAccess({ ...flowPermission, dataOperations: { read: true } }, true, 'update')).toBe(false);
  });
});
