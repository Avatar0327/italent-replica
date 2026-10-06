import { MODULE_OBJECTS } from '@italent/domain';
/** Q-M0-71：纯经理自动身份、当前组织范围、字段裁剪、工作台与租户隔离。 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createProfile, setObjectPermission } from './AC-PRM-support.js';
import { transferWorld } from './AC-TRF-manager-support.js';

const database = useTestDb();
const BASE = '/api/tenant/employment/transfers';
describe('AC-TRF-02/40–44 经理自助', () => {
  let world: Awaited<ReturnType<typeof transferWorld>>;
  let manager: { user: string; tenant: string };
  let self: { id: string; revision: number };
  let child: { id: string; revision: number };
  let member: { id: string; revision: number };
  beforeAll(async () => {
    world = await transferWorld(database().db);
    const user = await addMember(world, 'pure-manager');
    manager = { user: user.id, tenant: world.tenant.id };
    self = await world.person(world.outside.id, manager);
    const updated = await world.setup.request('PATCH', `/api/tenant/org/organizations/${world.inside.id}`, {
      ...world.asAdmin,
      ifMatch: world.inside.revision,
      body: { effectiveDate: '2026-01-02', personInChargeId: self.id },
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const response = await world.setup.request('POST', '/api/tenant/org/organizations', {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        name: '经理负责的下级部门',
        establishedOn: '2025-01-01',
        parents: { admin: { parentId: world.inside.id } },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    child = (await response.json()) as typeof child;
    member = await world.person(child.id);
  });

  it('AC-TRF-02：无手工身份、无 HR 授权，自动出现负责人自助并用完整表单暂存', async () => {
    const entry = await world.api.request('GET', `${BASE}/manager`, manager);
    expect(entry.status, await entry.clone().text()).toBe(200);
    expect(await entry.json()).toMatchObject({
      identity: 'department_manager',
      canApply: true,
      canViewReporting: false,
    });
    const saved = await world.transfer(manager, member, {
      initiator: 'manager',
      formId: 'TenantBase.TransferMultiFormView',
      fields: {},
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({ status: 'draft', initiator: 'manager' });
  });

  it('AC-TRF-40：候选默认空；按工号搜索包含下级；不包含范围外汇报下属、历史在范围内者', async () => {
    const outsider = await world.person(world.outside.id, undefined, self.id);
    const moved = await world.person(world.inside.id);
    const move = await world.setup.request('POST', `/api/tenant/employment/employees/${moved.id}/businesses`, {
      ...world.asAdmin,
      ifMatch: moved.revision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-02-01',
        fields: { departmentId: world.outside.id },
      },
    });
    expect(move.status, await move.clone().text()).toBe(201);
    const empty = await world.api.request('GET', `${BASE}/manager/employees`, manager);
    expect(await empty.json()).toMatchObject({ items: [] });
    const found = await world.api.request('GET', `${BASE}/manager/employees?search=TRF_`, manager);
    expect(found.status).toBe(200);
    const { items } = (await found.json()) as { items: { id: string }[] };
    expect(items.map((x) => x.id)).toContain(member.id);
    expect(items.map((x) => x.id)).not.toContain(outsider.id);
    expect(items.map((x) => x.id)).not.toContain(moved.id);
    for (const employee of [outsider, moved])
      for (const preview of [true, false]) {
        const denied = await world.transfer(
          manager,
          employee,
          {
            initiator: 'manager',
            formId: 'TenantBase.TransferMultiFormView',
            fields: {},
          },
          preview,
        );
        expect([403, 404]).toContain(denied.status);
      }
    expect(
      (
        await world.transfer(
          manager,
          { ...self, id: self.id.toUpperCase() },
          {
            initiator: 'manager',
            fields: {},
          },
          true,
        )
      ).status,
    ).toBe(403);
  });

  it('AC-TRF-41：字段模式与返回值裁剪；伪造不可编辑字段整单拒绝', async () => {
    const preview = await world.transfer(
      manager,
      member,
      {
        initiator: 'manager',
        formId: 'TenantBase.TransferMultiFormView',
        fields: {},
      },
      true,
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    const dto = (await preview.json()) as { fields: object; form: { fieldModes: object } };
    expect(dto.fields).not.toHaveProperty('remarks');
    expect(dto.form.fieldModes).not.toHaveProperty('preset:remarks');
    const denied = await world.transfer(manager, member, {
      initiator: 'manager',
      formId: 'TenantBase.TransferMultiFormView',
      fields: { remarks: '不可写' },
    });
    expect(denied.status).toBe(403);
  });

  it('AC-TRF-42/43：只读工作台仅负责组织；无 HR 无汇报关系页；待办三页签', async () => {
    const result = await world.api.request('GET', `${BASE}/manager/team?category=active`, manager);
    expect(result.status).toBe(200);
    const dto = (await result.json()) as { items: { id: string }[]; counts: object };
    expect(dto.items.map((x) => x.id)).toContain(member.id);
    expect(dto.items.map((x) => x.id)).not.toContain(self.id);
    expect(dto.counts).toMatchObject({
      active: expect.any(Number),
      probation: null,
      intern: 0,
      pending: 0,
      leaving: 0,
    });
    for (const tab of ['pending', 'processed', 'initiated']) {
      const response = await world.api.request('GET', `${BASE}/manager/todos?tab=${tab}`, manager);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect((await world.api.request('GET', `${BASE}/manager/reporting`, manager)).status).toBe(403);
  });

  it('AC-TRF-41：租户配置自动身份字段权限后，只读字段保留原值且后端拒绝显式改写', async () => {
    const profile = await createProfile(world, 'department_manager_self_service');
    for (const definition of [MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.employee]) {
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: {
            create: definition === MODULE_OBJECTS.employmentRecord,
            update: definition === MODULE_OBJECTS.employmentRecord,
            delete: false,
          },
          fields: definition.fields.map((field) => ({
            fieldCode: field.code,
            view: field.code !== 'remarks',
            edit: !field.system && !['remarks', 'departmentId'].includes(field.code),
          })),
          buttons:
            definition === MODULE_OBJECTS.employmentRecord ? [{ buttonCode: 'Transfer.Manager', level: 'detail' }] : [],
        },
        definition.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const preview = await world.transfer(
      manager,
      member,
      { initiator: 'manager', formId: 'TenantBase.TransferMultiFormView', fields: {} },
      true,
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await preview.json()).toMatchObject({
      fields: { departmentId: child.id },
      form: { fieldModes: { 'preset:departmentId': 'readonly' } },
    });
    const denied = await world.transfer(manager, member, {
      initiator: 'manager',
      formId: 'TenantBase.TransferMultiFormView',
      fields: { departmentId: world.outside.id },
    });
    expect(denied.status).toBe(403);
  });

  it('AC-TRF-42：实习、未来入职与离职中按负责组织统计，未来入职不成为调动候选', async () => {
    const intern = await world.person(child.id, undefined, undefined, { employType: 'intern' });
    const pending = await world.person(child.id, undefined, undefined, { effectiveDate: '2026-11-01' });
    const leaving = await world.person(child.id);
    const leave = await world.setup.request('POST', `/api/tenant/employment/employees/${leaving.id}/businesses`, {
      ...world.asAdmin,
      ifMatch: leaving.revision,
      body: { kind: 'leave', mode: 'direct', effectiveDate: '2026-11-01', lastWorkDate: '2026-10-31', fields: {} },
    });
    expect(leave.status, await leave.clone().text()).toBe(201);
    for (const [category, expected] of [
      ['intern', intern.id],
      ['pending', pending.id],
      ['leaving', leaving.id],
    ]) {
      const response = await world.api.request('GET', `${BASE}/manager/team?category=${category}`, manager);
      expect(response.status, await response.clone().text()).toBe(200);
      const dto = (await response.json()) as { items: { id: string }[]; counts: Record<string, number> };
      expect(
        dto.items.map((row) => row.id),
        category,
      ).toContain(expected);
      expect(dto.counts[category!]).toBeGreaterThan(0);
    }
    const candidates = await world.api.request('GET', `${BASE}/manager/employees?search=TRF_`, manager);
    expect(((await candidates.json()) as { items: { id: string }[] }).items.map((row) => row.id)).not.toContain(
      pending.id,
    );
  });

  it('AC-TRF-40：旧草稿提交也重验当前组织，宽泛显式范围不能绕过负责人限制', async () => {
    const employee = await world.person(child.id);
    const saved = await world.transfer(manager, employee, {
      initiator: 'manager',
      formId: 'TenantBase.TransferMultiFormView',
      fields: {},
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const draft = (await saved.json()) as { id: string; revision: number };
    const moved = await world.setup.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
      ...world.asAdmin,
      ifMatch: await world.currentRevision(employee),
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-02-01',
        fields: { departmentId: world.outside.id },
      },
    });
    expect(moved.status, await moved.clone().text()).toBe(201);
    const broad = await world.setup.request('PUT', `/api/tenant/permission/scopes/${manager.user}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: {
        kind: 'org_range',
        orgRanges: [world.inside.id, world.outside.id].map((orgId) => ({ orgId, includeDescendants: true })),
      },
    });
    expect(broad.status, await broad.clone().text()).toBe(200);
    const submit = await world.api.request('POST', `/api/tenant/employment/businesses/${draft.id}/submit`, {
      ...manager,
      ifMatch: draft.revision,
      body: {},
    });
    expect([403, 404]).toContain(submit.status);
  });

  it('AC-TRF-44：跨租户拒绝；撤销负责人后下一请求即失效', async () => {
    const foreign = await transferWorld(database().db);
    const employee = await foreign.person();
    expect([403, 404]).toContain(
      (
        await world.transfer(
          manager,
          employee,
          {
            initiator: 'manager',
            formId: 'TenantBase.TransferMultiFormView',
            fields: {},
          },
          true,
        )
      ).status,
    );
    const revoked = await world.setup.request('PATCH', `/api/tenant/org/organizations/${world.inside.id}`, {
      ...world.asAdmin,
      ifMatch: 2,
      body: { effectiveDate: '2026-09-01', personInChargeId: null },
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    // 仍有范围外汇报下属，可保留经理入口，但团队范围为空，不能保留旧组织数据。
    const result = await world.api.request('GET', `${BASE}/manager/team`, manager);
    if (result.status === 200) expect(await result.json()).toMatchObject({ items: [] });
    else expect(result.status).toBe(403);
  });
});
