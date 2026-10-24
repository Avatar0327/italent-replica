import { describe, expect, it } from 'vitest';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { flowFixture, flowId, flowPermission } from './support/f315-fixture.js';

describe('AC-FE-F315 流程设计器最小版', () => {
  it('01 配置中心挂载真实页面，审批中心实例页保留', () => {
    expect(PAGES.configurations.find((page) => page.id === 'processes')?.page?.name).toBe('ProcessDesigner');
    expect(PAGES.apps.find((page) => page.id === 'approval')?.page?.name).toBe('ApprovalPage');
  });
  it('02 仅改节点属性，保留其他节点、条件、规则与所有未编辑配置', async () => {
    const { buildDraft, nodeField } = await import('../../apps/web/src/approval/designer/model.js');
    const flow = flowFixture();
    const before = structuredClone(flow.latestVersion);
    const body = buildDraft(flow.latestVersion, { [nodeField('manager', 'name')]: '上级审核' });
    const expected = structuredClone(before);
    Object.assign(expected.nodes[0]!, { name: '上级审核' });
    const { id: _id, versionNo: _no, status: _status, publishedAt: _at, ...definition } = expected;
    expect(body).toEqual(definition);
    expect(flow.latestVersion).toEqual(before);
    expect(body).not.toHaveProperty('id');
    expect(body.nodes[0]?.noAssignee).toBe('exception_admin');
  });
  it('03 冲突按节点属性合并到最新回执，不覆盖未改字段', async () => {
    const { buildDraft, editableValues, nodeField } = await import('../../apps/web/src/approval/designer/model.js');
    const flow = flowFixture();
    const values = editableValues(flow.latestVersion);
    expect(values[nodeField('manager', 'name')]).toBe('上级审批');
    Object.assign(flow.latestVersion.nodes[0]!, { hideRecords: true });
    Object.assign(flow.latestVersion.nodes[1]!, { name: '其他人改的人事节点' });
    const result = buildDraft(flow.latestVersion, { [nodeField('manager', 'name')]: '我的节点名称' });
    expect(result.nodes[0]).toMatchObject({ name: '我的节点名称', hideRecords: true });
    expect(result.nodes[1]?.name).toBe('其他人改的人事节点');
    expect(() => buildDraft(flow.latestVersion, { [nodeField('deleted', 'name')]: '旧节点' })).toThrow();
    expect(() => buildDraft(flow.latestVersion, { [nodeField('manager', 'noAssignee')]: 'none' })).toThrow();
  });
  it('04 裁剪的定义不可整份保存，非法属性与空名称不可提交', async () => {
    const { buildDraft, completeDefinition, nodeField } = await import('../../apps/web/src/approval/designer/model.js');
    const version = flowFixture().latestVersion;
    expect(completeDefinition(version)).toBe(true);
    for (const field of ['conditions', 'nodes', 'hideRecordsFromInitiator', 'exceptionAdminUserId']) {
      const partial = { ...version } as Record<string, unknown>;
      delete partial[field];
      expect(completeDefinition(partial), field).toBe(false);
    }
    const partial = structuredClone(version);
    delete (partial.nodes[0] as unknown as Record<string, unknown>).messageRules;
    expect(completeDefinition(partial)).toBe(false);
    expect(() => buildDraft(version, { [nodeField('manager', 'name')]: '   ' })).toThrow();
  });
  it('05 导航和对象按钮不代替流程管理员能力，字段/操作/按钮独立控制', async () => {
    const { editAccess } = await import('../../apps/web/src/approval/designer/model.js');
    expect(editAccess(flowPermission, false, 'update')).toBe(false);
    expect(editAccess(flowPermission, true, 'update')).toBe(true);
    expect(editAccess({ ...flowPermission, editableFields: [] }, true, 'update')).toBe(false);
    expect(editAccess({ ...flowPermission, dataOperations: {} }, true, 'update')).toBe(false);
    expect(editAccess({ ...flowPermission, buttons: [] }, true, 'update')).toBe(false);
    expect(editAccess(undefined, true, 'update')).toBe(false);
  });
  it('06 成功回执按真实命令 revision、原单 ID、草稿状态验证', async () => {
    const { acceptProcessReceipt } = await import('../../apps/web/src/approval/designer/model.js');
    const value = flowFixture();
    expect(acceptProcessReceipt(value, flowId, 3).revision).toBe(4);
    expect(() => acceptProcessReceipt(value, flowId, 4)).toThrow();
    expect(() => acceptProcessReceipt(value, 'other', 3)).toThrow();
    expect(() => acceptProcessReceipt({ ...value, latestVersion: undefined }, flowId, 3)).toThrow();
    expect(() =>
      acceptProcessReceipt({ ...value, latestVersion: { ...value.latestVersion, status: 'published' } }, flowId, 3),
    ).toThrow();
  });
  it('14 保存载荷通过现有后端白名单解析，未编辑配置逐项保留', async () => {
    const { buildDraft, nodeField } = await import('../../apps/web/src/approval/designer/model.js');
    const { definitionSchema, toDefinition } = await import('../../apps/api/src/modules/approval/definition-input.js');
    const flow = flowFixture();
    const body = buildDraft(flow.latestVersion, {
      [nodeField('manager', 'name')]: '新名称',
      [nodeField('hr', 'actions.transfer')]: false,
    });
    expect(toDefinition(definitionSchema.parse(body), 'transfer')).toEqual(body);
    expect(body.nodes[1]?.actions.transfer).toBe(false);
    expect(body.conditions).toEqual(flow.latestVersion.conditions);
  });
});
