/** Q-M0-71：纯经理自动身份、当前组织范围、字段裁剪、工作台与租户隔离。 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember } from './AC-PRM-support.js';
import { transferWorld } from './AC-TRF-manager-support.js';

const database = useTestDb();
const BASE = '/api/tenant/employment/transfers';
describe('AC-TRF-02/37–41 经理自助', () => {
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

  it('AC-TRF-37：候选默认空；按工号搜索包含下级；不包含范围外汇报下属、历史在范围内者', async () => {
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

  it('AC-TRF-38：字段模式与返回值裁剪；伪造不可编辑字段整单拒绝', async () => {
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

  it('AC-TRF-39/40：只读工作台仅负责组织；无 HR 无汇报关系页；待办三页签', async () => {
    const result = await world.api.request('GET', `${BASE}/manager/team?category=active`, manager);
    expect(result.status).toBe(200);
    const dto = (await result.json()) as { items: { id: string }[]; counts: object };
    expect(dto.items.map((x) => x.id)).toContain(member.id);
    expect(dto.items.map((x) => x.id)).not.toContain(self.id);
    expect(dto.counts).toMatchObject({ active: expect.any(Number), probation: 0, intern: 0, pending: 0, leaving: 0 });
    for (const tab of ['pending', 'processed', 'initiated']) {
      const response = await world.api.request('GET', `${BASE}/manager/todos?tab=${tab}`, manager);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect((await world.api.request('GET', `${BASE}/manager/reporting`, manager)).status).toBe(403);
  });

  it('AC-TRF-41：跨租户拒绝；撤销负责人后下一请求即失效', async () => {
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
