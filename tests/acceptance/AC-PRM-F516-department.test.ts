import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE } from './AC-PRM-support.js';
import { f516World } from './AC-PRM-F516-support.js';

const database = useTestDb();
describe('AC-PRM-F516 管理员主职部门与含下级筛选', () => {
  let w: Awaited<ReturnType<typeof f516World>>;
  let root: string;
  let child: string;
  let other: string;
  let person: Awaited<ReturnType<typeof w.person>>;
  beforeAll(async () => {
    w = await f516World(database().db);
    root = await w.hr.org('合成上级');
    other = await w.hr.org('合成其他');
    const response = await w.call('POST', '/api/tenant/org/organizations', {
      ifMatch: 0,
      body: { name: '合成下级', establishedOn: '2020-01-01', parents: { admin: { parentId: root } } },
    });
    expect(response.status).toBe(201);
    child = ((await response.json()) as { id: string }).id;
    person = await w.person('合成管理员');
    expect((await w.hr.hire(person, child)).status).toBe(201);
    const admin = await w.call('POST', `${BASE}/admins`, {
      body: { userId: person.userId, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(admin.status, await admin.clone().text()).toBe(201);
  });
  it('兼职部门不覆盖主职部门，也不参与管理员部门匹配', async () => {
    const partTime = await w.call('POST', `/api/tenant/employment/employees/${person.id}/part-times`, {
      body: { partTimeType: 'part_time', startDate: '2026-09-15', fields: { departmentId: other } },
    });
    expect(partTime.status, await partTime.clone().text()).toBe(201);
    expect((await w.page('/admins')).items.find((row) => row.userId === person.userId)).toMatchObject({
      department: { id: child, name: '合成下级' },
    });
    expect((await w.page(`/admins?departmentId=${other}`)).total).toBe(0);
  });
  it('取当前生效主职部门，无档案为空', async () => {
    const page = await w.page('/admins');
    expect(page.items.find((row) => row.userId === person.userId)).toMatchObject({
      department: { id: child, name: '合成下级' },
    });
    expect(page.items.find((row) => row.userId === w.admin.id)).toMatchObject({ department: null });
    expect(page.unrecorded).toEqual([]);
  });
  it('选上级包含下级，分页与 total 共用条件，其他部门和不存在部门为空', async () => {
    for (const departmentId of [root, child]) {
      const page = await w.page(`/admins?departmentId=${departmentId}&limit=1`);
      expect(page.items.map((row) => row.userId)).toEqual([person.userId]);
      expect(page.total).toBe(1);
      expect((await w.page(`/admins?departmentId=${departmentId}&offset=1`)).items).toEqual([]);
    }
    expect((await w.page(`/admins?departmentId=${other}`)).total).toBe(0);
    expect((await w.page(`/admins?departmentId=${root}&role=user_admin`)).total).toBe(0);
  });
  it('未来调动不提前改变部门，按租户当天取值', async () => {
    const current = await w.hr.getEmployee(person.id);
    const moved = await w.call('POST', `/api/tenant/employment/employees/${person.id}/businesses`, {
      ifMatch: current.revision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-02', fields: { departmentId: other } },
    });
    expect(moved.status, await moved.clone().text()).toBe(201);
    expect((await w.page('/admins')).items.find((row) => row.userId === person.userId)).toMatchObject({
      department: { id: child, name: '合成下级' },
    });
  });
  it('部门范围与字段裁剪影响筛选和投影，非法 ID 返回 400', async () => {
    expect((await w.page(`/admins?departmentId=${root}`, w.restricted([]))).total).toBe(0);
    const hidden = w.restricted(undefined, ['orgFullName']);
    expect((await w.page('/admins', hidden)).items.find((row) => row.userId === person.userId)).not.toHaveProperty(
      'department',
    );
    expect((await hidden.request('GET', `${BASE}/admins?departmentId=${root}`, w.asAdmin)).status).toBe(403);
    expect((await w.api.request('GET', `${BASE}/admins?departmentId=bogus`, w.asAdmin)).status).toBe(400);
  });
});
