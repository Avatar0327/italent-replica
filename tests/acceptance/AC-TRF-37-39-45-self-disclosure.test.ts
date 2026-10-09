import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin, type Person } from './AC-APV-support.js';
import { createProfile, setObjectPermission, type ProfileBody } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
let world: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let admin: Awaited<ReturnType<typeof permissionAdmin>>;
let policy: ProfileBody;
let self: Person;
let head: Person;
let ancestor: Person;
let outsider: Person;
let child: Person;
let leaver: Person;
let target: string;
let postId: string;
let newPostId: string;
const request = (path: string, body?: unknown, revision?: number) =>
  api.request(body ? 'POST' : 'GET', `/api/tenant/self-service${path}`, {
    ...world.as(self.userId),
    body,
    ifMatch: revision,
  });
const input = (fields: Record<string, unknown> = {}) => ({
  effectiveDate: '2026-10-19',
  fields: { departmentId: target, ...fields },
});
const revision = async () =>
  (await world.json<{ employee: { revision: number } }>(await request('/profile'))).employee.revision;
const configure = async (dateMode: 'editable' | 'readonly' | 'hidden', extra: string[] = []) => {
  policy ??= await createProfile(admin, 'employee_self_service');
  await world.json(
    await setObjectPermission(
      admin,
      policy,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: [
          { fieldCode: 'effectiveDate', view: dateMode !== 'hidden', edit: dateMode === 'editable' },
          ...['departmentId', 'directManagerId', 'postId', 'levelId', 'sequenceId', ...extra].map((fieldCode) => ({
            fieldCode,
            view: true,
            edit: !extra.includes(fieldCode),
          })),
        ],
        buttons: [],
      },
      'TenantBase.EmploymentRecord',
    ),
  );
};

beforeAll(async () => {
  world = await approvalWorld(database().db, 'self-disclosure');
  api = tenantApi(database().db, { authorize: undefined, clock: world.clock });
  const parent = await world.org('合成上级');
  target = await world.org('合成目标', parent);
  const sibling = await world.org('合成旁支', parent);
  head = await world.person('合成负责人', target);
  ancestor = await world.person('合成上级经理', parent);
  outsider = await world.person('范围外经理秘密姓名', sibling);
  child = await world.person('合成下级经理', await world.org('合成下级', target));
  leaver = await world.person('合成已离职经理', target);
  const current = await world.json<{ revision: number }>(
    await world.request(world.hr.id, 'GET', `/api/tenant/employment/employees/${leaver.employeeId}`),
  );
  await world.json(
    await world.request(world.hr.id, 'POST', `/api/tenant/employment/employees/${leaver.employeeId}/businesses`, {
      ifMatch: current.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
    }),
    201,
  );
  await world.setOrgRoles(target, { head: head.employeeId });
  const job = async (code: string, name: string) =>
    (
      await world.json<{ id: string }>(
        await world.request(world.hr.id, 'POST', '/api/tenant/job/posts', {
          ifMatch: 0,
          body: { code, name, startDate: '2020-01-01' },
        }),
        201,
      )
    ).id;
  postId = await job('original-post', '可信原职务');
  newPostId = await job('outside-post', '范围外职务秘密名称');
  self = await world.person('合成本人', sibling, { postId, directManagerId: outsider.employeeId });
  await world.publishedProcess({ nodes: [{ key: 'owner_review', approver: 'owner' }] });
  admin = await permissionAdmin(world);
});

describe('AC-TRF-37/39/45 第二轮：DEC-209 与响应披露', () => {
  it('P2-1：客户端范围外经理不能预览名称或提交；改部门后重新校验', async () => {
    for (const manager of [outsider, child, leaver]) {
      const body = input({ directManagerId: manager.employeeId });
      const preview = await request('/transfer/preview', body);
      expect(preview.status).toBe(403);
      expect(await preview.text()).not.toContain(manager === outsider ? '范围外经理秘密姓名' : '合成下级经理');
      expect((await request('/transfer', body, await revision())).status).toBe(403);
    }
    const changedDepartment = input({
      departmentId: await world.org('合成切换目标'),
      directManagerId: head.employeeId,
    });
    expect((await request('/transfer/preview', changedDepartment)).status).toBe(403);
    expect((await request('/transfer', changedDepartment, await revision())).status).toBe(403);
  });

  it('DEC-209：候选仅新部门及其上级链在职人员，含组织路径，不含邮箱', async () => {
    const result = await world.json<{ items: { id: string; name: string; orgPath: string }[] }>(
      await request(`/transfer/references/directManagerId?asOf=2026-10-19&departmentId=${target.toUpperCase()}`),
    );
    expect(result.items.map((item) => item.id).sort()).toEqual([head.employeeId, ancestor.employeeId].sort());
    expect(result.items.every((item) => item.orgPath.includes('合成'))).toBe(true);
    expect(result.items.every((item) => Object.keys(item).sort().join() === 'avatar,id,name,orgPath')).toBe(true);
    expect(result.items.every((item) => (item as { avatar?: unknown }).avatar === null)).toBe(true);
    expect(await world.json(await request('/transfer/references/directManagerId'))).toEqual({ items: [] });
    const foreign = await approvalWorld(database().db, 'self-candidate-foreign');
    const org = await foreign.org('外租户部门');
    expect(await world.json(await request(`/transfer/references/directManagerId?departmentId=${org}`))).toEqual({
      items: [],
    });
    const foreignPerson = await foreign.person('外租户经理秘密姓名', org);
    expect((await request('/transfer/preview', input({ directManagerId: foreignPerson.employeeId }))).status).toBe(403);
    expect(
      await world.json(
        await request(
          `/transfer/references/directManagerId?asOf=2026-10-19&departmentId=${target}&name=上级经理&pageSize=1`,
        ),
      ),
    ).toMatchObject({ items: [{ id: ancestor.employeeId }] });
  });

  it('P2-1：职务/职级/序列只读，不提供候选；范围外 postId 不回显名称', async () => {
    const preview = await world.json(await request('/transfer/preview', input()));
    expect(preview).toMatchObject({
      form: {
        fieldModes: {
          'preset:postId': 'readonly',
          'preset:levelId': 'readonly',
          'preset:sequenceId': 'readonly',
        },
      },
    });
    for (const code of ['postId', 'levelId', 'sequenceId']) {
      expect(await world.json(await request(`/transfer/references/${code}`))).toEqual({ items: [] });
      const response = await request('/transfer/preview', input({ [code]: newPostId }));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('范围外职务秘密名称');
      expect((await request('/transfer', input({ [code]: newPostId }), await revision())).status).toBe(403);
    }
  });

  it('P2-1：可信原值和自动带出值仍显示；合法经理可改且正常走审批', async () => {
    expect(await world.json(await request('/transfer/preview', input()))).toMatchObject({
      beforeLabels: { postId: '可信原职务', directManagerId: '范围外经理秘密姓名' },
      valueLabels: { postId: '可信原职务', directManagerId: '合成负责人' },
    });
    const body = input({ directManagerId: ancestor.employeeId.toUpperCase() });
    expect(await world.json(await request('/transfer/preview', body))).toMatchObject({
      valueLabels: { directManagerId: '合成上级经理' },
    });
    expect(await world.json(await request('/transfer', body, await revision()), 201)).toMatchObject({
      status: 'in_review',
    });
  });

  it('P2-2：默认不披露 staffId/previousRecordId，授权后可读、撤权后即时裁剪', async () => {
    const hidden = await world.json(await request('/transfer/preview', input()));
    expect(hidden).not.toHaveProperty('staffId');
    expect(hidden).not.toHaveProperty('previousRecordId');
    await configure('editable', ['staffId', 'previousRecordId']);
    const granted = await world.json(await request('/transfer/preview', input()));
    expect(granted).toHaveProperty('staffId');
    expect(granted).toHaveProperty('previousRecordId');
    await configure('editable');
    const revoked = await world.json(await request('/transfer/preview', input()));
    expect(revoked).not.toHaveProperty('staffId');
    expect(revoked).not.toHaveProperty('previousRecordId');
    // 租户误配编辑权也不能放开 DEC-209 的员工只读字段。
    expect((await request('/transfer/preview', input({ postId: newPostId }))).status).toBe(403);
  });

  it('P2-2：撤销日期查看权后，既有申请列表、详情、本人任职均不返回日期', async () => {
    const before = await world.json<{ items: { id: string; effectiveDate?: string }[] }>(
      await request('/applications'),
    );
    expect(before.items[0]).toHaveProperty('effectiveDate', '2026-10-19');
    await configure('hidden');
    const list = await world.json<{ items: { id: string }[] }>(await request('/applications'));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('effectiveDate');
    const detail = await world.json<{ record: object }>(await request(`/applications/${list.items[0]!.id}`));
    expect(detail.record).not.toHaveProperty('effectiveDate');
    const profile = await world.json<{ record: object }>(await request('/profile'));
    expect(profile.record).not.toHaveProperty('effectiveDate');
  });

  it('日期隐藏或只读时禁止发起并返回专用机器码，不产生申请', async () => {
    for (const mode of ['hidden', 'readonly'] as const) {
      await configure(mode);
      for (const path of ['/transfer/preview', '/transfer']) {
        const response = await request(path, input(), await revision());
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'SELF_TRANSFER_DATE_UNAVAILABLE' } });
      }
    }
    expect((await world.json<{ items: object[] }>(await request('/applications'))).items).toHaveLength(1);
  });
});
