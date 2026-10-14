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

describe('AC-FE-R1a-05 服务端权限契约', () => {
  it('权限接口没有 read 开关；对象授权返回成功代表可进入，写操作还须按钮与操作开关', async () => {
    const { pageAccess } = await org();
    const permission = {
      objectCode: 'TenantBase.Organization',
      dataOperations: { create: false, update: true, delete: false },
      viewableFields: ['name', 'remarks'],
      editableFields: ['name'],
      buttons: [{ buttonCode: 'update', level: 'detail' }],
    };
    expect(pageAccess(undefined).readable).toBe(false);
    expect(pageAccess(permission).readable).toBe(true);
    expect(pageAccess(permission).can('create', 'list')).toBe(false);
    expect(pageAccess(permission).can('update')).toBe(true);
    expect(pageAccess(permission).field('remarks')).toEqual({ visible: true, editable: false });
    expect(pageAccess(permission).field('parents')).toEqual({ visible: false, editable: false });
  });
});

it('AC-FE-R1a-10 职位多维上级分别提交，编辑一维保留另一维，空上级使用 null', async () => {
  const { jobBody } = await job();
  const parent = '10000000-0000-4000-8000-000000000003';
  const position = {
    ...original,
    parents: { admin: { parentId: parent, sequence: 1 }, dotted: { parentId: parent, sequence: 2 } },
  };
  expect(jobBody('positions', { adminParent: '', adminSequence: 3 }, position, '2026-10-12')).toEqual({
    effectiveDate: '2026-10-12',
    parents: { admin: { parentId: null, sequence: 3 }, dotted: position.parents.dotted },
  });
});

it('AC-FE-R1a-11 服务端已计算的业务按钮不依赖不存在的同名数据操作开关', async () => {
  const { pageAccess } = await org();
  expect(
    pageAccess({
      objectCode: 'TenantBase.JobPost',
      dataOperations: { update: true },
      viewableFields: [],
      editableFields: [],
      buttons: [{ buttonCode: 'syncSequence', level: 'list' }],
    }).can('syncSequence', 'list'),
  ).toBe(true);
});

describe('AC-FE-R1a-17 职务写入只包含授权表单输入', () => {
  it('八类新建均不补写 startDate，允许服务端按租户当天默认', async () => {
    const { jobBody, jobKinds } = await job();
    for (const kind of jobKinds) {
      const values = kind === 'positions' ? { name: '合成', orgId: 'A', postId: 'B' } : { name: '合成' };
      expect(jobBody(kind, values, undefined, '2026-10-13')).not.toHaveProperty('startDate');
      expect(jobBody(kind, { ...values, startDate: '2026-10-14' }, undefined, '2026-10-13')).toHaveProperty(
        'startDate',
        '2026-10-14',
      );
    }
  });
  it('编辑不重发未改字段，保留变更生效日期', async () => {
    const { jobBody } = await job();
    expect(jobBody('posts', { name: ' 合成部门 ', code: 'new' }, original, '2026-10-13')).toEqual({
      code: 'new',
      effectiveDate: '2026-10-13',
    });
  });
});

describe('AC-FE-R1a-20 新建日期与候选共用时点（DEC-465）', () => {
  it('有日期编辑权用所选未来日期，只读或隐藏时用后端租户当天且省略日期', async () => {
    const { jobTiming, jobBody, jobKinds } = await job();
    for (const kind of jobKinds) {
      for (const access of [
        { visible: true, editable: true },
        { visible: true, editable: false },
        { visible: false, editable: false },
      ]) {
        const timing = jobTiming(undefined, '2026-10-20', '2026-10-13', access);
        const values = kind === 'positions' ? { name: '合成', orgId: 'A', postId: 'B' } : { name: '合成' };
        const body = jobBody(kind, { ...values, ...timing.createFields }, undefined, timing.asOf);
        expect(timing.asOf).toBe(access.editable ? '2026-10-20' : '2026-10-13');
        if (access.editable) expect(body).toHaveProperty('startDate', '2026-10-20');
        else expect(body).not.toHaveProperty('startDate');
      }
    }
  });
  it('编辑继续使用所选变更日期，不补写新建日期', async () => {
    const { jobTiming, jobBody } = await job();
    const timing = jobTiming(original, '2026-10-20', '2026-10-13', { visible: true, editable: false });
    expect(timing).toEqual({ asOf: '2026-10-20', createFields: {} });
    expect(jobBody('posts', { name: '改名', ...timing.createFields }, original, timing.asOf)).toEqual({
      name: '改名',
      effectiveDate: '2026-10-20',
    });
  });
});
