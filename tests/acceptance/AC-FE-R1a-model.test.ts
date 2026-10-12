import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const org = () => import(resolve('apps/web/src/org/page-model.ts'));
const job = () => import(resolve('apps/web/src/job/page-model.ts'));
const original = {
  id: '10000000-0000-4000-8000-000000000001',
  revision: 2,
  name: '合成部门',
  parents: { admin: { parentId: '10000000-0000-4000-8000-000000000002', sequence: 3 } },
};
describe('AC-FE-R1a-01 组织变更与多维树', () => {
  it('改名必须显式选择任职联动，备注变更不发送联动字段', async () => {
    const { orgChangeBody } = await org();
    expect(() => orgChangeBody(original, { name: '新名称' }, '2026-10-12')).toThrow();
    expect(orgChangeBody(original, { name: '新名称', addEmployment: false }, '2026-10-12')).toEqual({
      name: '新名称',
      effectiveDate: '2026-10-12',
      addEmployment: false,
    });
    expect(orgChangeBody(original, { remarks: '说明', addEmployment: true }, '2026-10-12')).toEqual({
      remarks: '说明',
      effectiveDate: '2026-10-12',
    });
  });
  it('修改上级保留该维度顺序号，不覆盖其他维度；隐藏名称不会被补写', async () => {
    const { orgChangeBody } = await org();
    expect(
      orgChangeBody(
        original,
        { adminParent: '10000000-0000-4000-8000-000000000003', addEmployment: true },
        '2026-10-12',
      ),
    ).toEqual({
      parents: { admin: { parentId: '10000000-0000-4000-8000-000000000003', sequence: 3 } },
      effectiveDate: '2026-10-12',
      addEmployment: true,
    });
    expect(orgChangeBody({ id: original.id, revision: 1 }, { remarks: '' }, '2026-10-12')).not.toHaveProperty('name');
  });
  it('树按所选维度连接，范围外父级不伪造；坏环不会无限递归', async () => {
    const { organizationTree } = await org();
    const rows = [original, { id: original.parents.admin.parentId, revision: 1, name: '合成集团' }];
    expect(organizationTree(rows, 'admin')[0].children[0].key).toBe(original.id);
    expect(organizationTree(rows, 'business')).toHaveLength(2);
    expect(organizationTree([original], 'admin')[0].key).toBe(original.id);
    expect(organizationTree([{ ...original, parents: { admin: { parentId: original.id } } }], 'admin')).toHaveLength(1);
  });
});
describe('AC-FE-R1a-02 职务表单', () => {
  it('职位必须有组织与职务；不把空引用变成空字符串提交', async () => {
    const { jobBody } = await job();
    expect(() => jobBody('positions', { name: '合成职位' }, undefined, '2026-10-12')).toThrow();
    expect(jobBody('posts', { name: ' 合成职务 ', sequenceId: '' }, undefined, '2026-10-12')).toEqual({
      name: '合成职务',
      sequenceId: null,
      startDate: '2026-10-12',
    });
  });
  it('编辑换非空序列必须同步，清空不触发，revision 留给命令头', async () => {
    const { jobBody } = await job();
    expect(jobBody('posts', { sequenceId: 'A' }, { ...original, sequenceId: 'b' }, '2026-10-12')).toEqual({
      sequenceId: 'a',
      syncSequenceToAssignments: true,
      effectiveDate: '2026-10-12',
    });
    expect(jobBody('posts', { sequenceId: '' }, { ...original, sequenceId: 'b' }, '2026-10-12')).toEqual({
      sequenceId: null,
      effectiveDate: '2026-10-12',
    });
  });
});
