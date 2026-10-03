import { randomUUID } from 'node:crypto';
import { PERSONNEL_OBJECTS, PERSONNEL_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
describe('AC-SUB DEC-080/081 人员范围与敏感字段', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });
  async function fixture() {
    const db = database().db;
    const seed = await seedPermissionWorld(db);
    const clock = () => new Date('2026-10-01T01:00:00Z');
    const setup = tenantApi(db, { clock });
    const api = tenantApi(db, { clock, authorize: undefined });
    const user = await addMember(seed, 'personnel-reader');
    const noScope = await addMember(seed, 'personnel-empty');
    const profile = await createProfile(seed, 'personnel');
    for (const definition of PERSONNEL_OBJECTS) {
      const allowed = ['id', 'employeeId', 'revision', 'code', 'school', 'isHighestEducation', 'sourceType'];
      if (definition.code === PERSONNEL_OBJECT) allowed.push('levelSortNumber');
      expect(
        (
          await setObjectPermission(
            seed,
            profile,
            {
              dataOperations: { create: true, update: true, delete: true },
              fields: definition.fields.map((f) => ({
                fieldCode: f.code,
                view: allowed.includes(f.code),
                edit: !f.system && allowed.includes(f.code),
              })),
              buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
            },
            definition.code,
          )
        ).status,
      ).toBe(200);
    }
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, user.id, profile.id)).status).toBe(201);
    expect((await grant(seed, noScope.id, profile.id)).status).toBe(201);
    const create = async (path: string, body: object, ifMatch = 0) => {
      const r = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, body, ifMatch });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json()) as { id: string; revision: number; employeeRevision: number };
    };
    const inside = await create('org/organizations', {
      name: '内部门',
      startDate: '2020-01-01',
      parents: { admin: { parentId: seed.tenant.id } },
    });
    const outside = await create('org/organizations', {
      name: '外部门',
      startDate: '2020-01-01',
      parents: { admin: { parentId: seed.tenant.id } },
    });
    const employee = async (code: string, org: string) => {
      const person = await create('employment/employees', { code, name: '保密姓名' });
      await create(
        `employment/employees/${person.id}/businesses`,
        { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: { departmentId: org } },
        1,
      );
      const changed = await setup.request('PATCH', `/api/tenant/personnel/employees/${person.id}`, {
        ...seed.asAdmin,
        ifMatch: 0,
        body: { idNumber: 'SYNTHETIC-SECRET-ID', mobilePhone: 'SYNTHETIC-SECRET-PHONE' },
      });
      expect(changed.status).toBe(200);
      const education = await create(`personnel/employees/${person.id}/subsets/education`, {
        school: `大学-${code}`,
        degree: '保密学位',
        educationLevel: '保密学历',
      });
      await create(`personnel/employees/${person.id}/subsets/family`, { name: '保密家属' });
      return { person, education };
    };
    const hidden = await employee('A-OUT', outside.id);
    const visible = await employee('Z-IN', inside.id);
    expect(
      (
        await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
          ...seed.asAdmin,
          ifMatch: 0,
          body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
        })
      ).status,
    ).toBe(200);
    return {
      ...seed,
      inside,
      outside,
      api,
      setup,
      visible,
      hidden,
      noScope,
      user,
      as: { user: user.id, tenant: seed.tenant.id },
    };
  }
  it('先按管理人员过滤再分页；历史日期无法扩大范围', async () => {
    const r = await world.api.request(
      'GET',
      '/api/tenant/personnel/subsets/education?sortBy=code&pageSize=1',
      world.as,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: [{ id: world.visible.education.id, school: '大学-Z-IN' }] });
    for (const suffix of ['', '/tenure?asOf=2020-01-01', '/history', '/subsets/education']) {
      expect(
        (await world.api.request('GET', `/api/tenant/personnel/employees/${world.hidden.person.id}${suffix}`, world.as))
          .status,
      ).toBe(404);
    }
  });
  it('详情、嵌套列表、历史、写响应均按各自真实字段目录裁剪', async () => {
    const id = world.visible.person.id;
    for (const path of [
      `/employees/${id}?includeSubsets=true`,
      `/employees/${id}/history`,
      '/subsets/education',
      `/employees/${id}/subsets/education/${world.visible.education.id}/history`,
    ]) {
      const response = await world.api.request('GET', `/api/tenant/personnel${path}`, world.as);
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const value of ['保密', 'SYNTHETIC-SECRET', 'idNumber', 'mobilePhone', 'employeeName'])
        expect(text).not.toContain(value);
    }
    const r = await world.api.request(
      'PATCH',
      `/api/tenant/personnel/employees/${id}/subsets/education/${world.visible.education.id}`,
      {
        ...world.as,
        ifMatch: 1,
        body: { school: '修改允许字段' },
      },
    );
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain('保密');
  });
  it('隐藏字段写入、隐藏字段排序、真实按钮和操作不可绕过', async () => {
    const path = `/api/tenant/personnel/employees/${world.visible.person.id}/subsets/education`;
    expect((await world.api.request('POST', path, { ...world.as, ifMatch: 0, body: { degree: '越权' } })).status).toBe(
      403,
    );
    expect(
      (await world.api.request('GET', '/api/tenant/personnel/subsets/education?sortBy=employeeName', world.as)).status,
    ).toBe(403);
    const denied = tenantApi(database().db, { authorize: (r) => r.action !== 'object.button' });
    expect((await denied.request('POST', path, { ...world.as, ifMatch: 0, body: { school: '无按钮' } })).status).toBe(
      403,
    );
    const noCreate = tenantApi(database().db, { authorize: (r) => r.action !== 'object.create' });
    expect((await noCreate.request('POST', path, { ...world.as, ifMatch: 0, body: { school: '无新增' } })).status).toBe(
      403,
    );
  });
  it('无范围用户列表为空，点查/写入返回 404；跨租户 ID 返回 404', async () => {
    const as = { user: world.noScope.id, tenant: world.tenant.id };
    const r = await world.api.request('GET', '/api/tenant/personnel/employees', as);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: [], hasDataPermission: false });
    expect(
      (
        await world.api.request(
          'POST',
          `/api/tenant/personnel/employees/${world.visible.person.id}/subsets/education`,
          { ...as, ifMatch: 0, body: { school: '不应写入' } },
        )
      ).status,
    ).toBe(404);
    expect((await world.api.request('GET', `/api/tenant/personnel/employees/${randomUUID()}`, world.as)).status).toBe(
      404,
    );
  });
  it('幂等重放重新检查当前范围，撤销后不能返回旧响应', async () => {
    const member = await addMember(world, 'replay-personnel');
    const profile = await createProfile(world, `replay-${randomUUID()}`);
    expect(
      (
        await setObjectPermission(
          world,
          profile,
          {
            dataOperations: { create: true, update: false, delete: false },
            fields: [{ fieldCode: 'school', view: true, edit: true }],
            buttons: [{ buttonCode: 'create', level: 'list' }],
          },
          'TenantBase.Education',
        )
      ).status,
    ).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, member.id, profile.id)).status).toBe(201);
    const scopePath = `/api/tenant/permission/scopes/${member.id}/TenantBase`;
    expect(
      (
        await world.api.request('PUT', scopePath, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { kind: 'org_range', orgRanges: [{ orgId: world.inside.id, includeDescendants: false }] },
        })
      ).status,
    ).toBe(200);
    const opts = {
      user: member.id,
      tenant: world.tenant.id,
      ifMatch: 0,
      idempotencyKey: randomUUID(),
      body: { school: '重放裁剪' },
    };
    const path = `/api/tenant/personnel/employees/${world.visible.person.id}/subsets/education`;
    expect((await world.api.request('POST', path, opts)).status).toBe(201);
    expect(
      (
        await world.api.request('PUT', scopePath, {
          ...world.asAdmin,
          ifMatch: 1,
          body: { kind: 'org_range', orgRanges: [] },
        })
      ).status,
    ).toBe(200);
    expect((await world.api.request('POST', path, opts)).status).toBe(404);
  });
  it('DEC-082 创建人规则只允许在管理人员范围内新增，已建记录按实际子集创建人读取', async () => {
    const code = 'TenantBase.Education';
    const policy = await world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${code}/entity/${code}`,
      {
        ...world.asAdmin,
        ifMatch: 0,
        body: { rules: [{ dimension: 'using_user' }], personField: 'employeeId' },
      },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    const path = (employeeId: string) => `/api/tenant/personnel/employees/${employeeId}/subsets/education`;
    expect(
      (
        await world.api.request('POST', path(world.hidden.person.id), {
          ...world.as,
          ifMatch: 0,
          body: { school: '范围外禁止' },
        })
      ).status,
    ).toBe(404);
    const created = await world.api.request('POST', path(world.visible.person.id), {
      ...world.as,
      ifMatch: 0,
      body: { school: '本人创建的经历' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const item = (await created.json()) as { id: string };
    const list = await world.api.request('GET', '/api/tenant/personnel/subsets/education', world.as);
    expect(await list.json()).toMatchObject({ items: [{ id: item.id, school: '本人创建的经历' }] });
    expect((await world.api.request('GET', `${path(world.visible.person.id)}/${item.id}`, world.as)).status).toBe(200);
    expect(
      (await world.api.request('GET', `${path(world.visible.person.id)}/${world.visible.education.id}`, world.as))
        .status,
    ).toBe(404);
  });
});
