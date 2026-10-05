/** AC-PRM-03/22/29：真实授权器、当前管理人员与各条任职部门的 AND，以及嵌套响应裁剪。 */
import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
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
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();

describe('AC-PRM-03/22/29 任职数据范围与字段裁剪', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });

  async function fixture() {
    const db = database().db;
    const original = await seedPermissionWorld(db);
    const clock = () => new Date('2026-10-01T01:00:00.000Z');
    const api = tenantApi(db, { authorize: undefined, clock });
    const setup = tenantApi(db, { clock });
    const seed = { ...original, api };
    async function create(path: string, body: unknown, revision = 0) {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, ifMatch: revision, body });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string; revision: number; employeeRevision?: number };
    }
    const org = async (name: string) =>
      create('org/organizations', {
        name,
        establishedOn: '2025-01-01',
        parents: { admin: { parentId: seed.tenant.id } },
      });
    const inside = await org('管理内部门');
    const outside = await org('管理外部门');
    async function employee(previousDepartment: string, currentDepartment: string) {
      const employee = await create('employment/employees', { code: `E_${randomUUID()}`, name: '隐藏姓名' });
      const hire = await create(
        `employment/employees/${employee.id}/businesses`,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-01-01',
          fields: { departmentId: previousDepartment, remarks: '隐藏备注', place: '可见地点' },
          loginEmail: loginEmailOf(employee.id),
        },
        employee.revision,
      );
      const current = await create(
        `employment/employees/${employee.id}/businesses`,
        {
          kind: 'transfer',
          mode: 'direct',
          effectiveDate: '2026-09-01',
          fields: { departmentId: currentDepartment },
        },
        hire.employeeRevision,
      );
      return { employee, hire, current };
    }
    const movedIn = await employee(outside.id, inside.id);
    const movedOut = await employee(inside.id, outside.id);
    const inScope = await employee(inside.id, inside.id);
    const allowedFuture = await create(
      `employment/employees/${inScope.employee.id}/businesses`,
      {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-12-01',
        fields: { departmentId: inside.id },
      },
      inScope.current.employeeRevision,
    );
    const future = await create(
      `employment/employees/${movedIn.employee.id}/businesses`,
      {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-12-01',
        fields: { departmentId: outside.id },
      },
      movedIn.current.employeeRevision,
    );
    const user = await addMember(seed, 'scope-reader');
    const approver = await addMember(seed, 'approval-participant');
    const profile = await createProfile(seed, 'employment-reader');
    for (const definition of [
      { code: 'TenantBase.Employee', fields: ['id', 'code', 'revision', 'status'], buttons: [] },
      {
        code: MODULE_OBJECTS.employmentRecord.code,
        fields: [
          'id',
          'employeeId',
          'revision',
          'effectiveDate',
          'kind',
          'status',
          'departmentId',
          'place',
          'previousRecordId',
          'staffId',
        ],
        buttons: MODULE_OBJECTS.employmentRecord.buttons.map((button) => ({
          buttonCode: button.code,
          level: button.level,
        })),
      },
    ]) {
      const response = await setObjectPermission(
        seed,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((fieldCode) => ({ fieldCode, view: true, edit: false })),
          buttons: definition.buttons,
        },
        definition.code,
      );
      expect(response.status).toBe(200);
    }
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, user.id, profile.id)).status).toBe(201);
    expect((await grant(seed, approver.id, profile.id)).status).toBe(201);
    const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
    });
    expect(scope.status).toBe(200);
    const writer = await addMember(seed, 'scope-writer');
    const writerProfile = await createProfile(seed, 'employment-writer');
    const writerPermission = await setObjectPermission(
      seed,
      writerProfile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: MODULE_OBJECTS.employmentRecord.fields.map((field) => ({
          fieldCode: field.code,
          view: true,
          edit: !field.system,
        })),
        buttons: MODULE_OBJECTS.employmentRecord.buttons.map((button) => ({
          buttonCode: button.code,
          level: button.level,
        })),
      },
      MODULE_OBJECTS.employmentRecord.code,
    );
    expect(writerPermission.status).toBe(200);
    await makeGrantable(seed, [writerProfile.id]);
    expect((await grant(seed, writer.id, writerProfile.id)).status).toBe(201);
    expect(
      (
        await api.request('PUT', `/api/tenant/permission/scopes/${writer.id}/TenantBase`, {
          ...seed.asAdmin,
          ifMatch: 0,
          body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
        })
      ).status,
    ).toBe(200);
    const as = { user: user.id, tenant: seed.tenant.id };
    const asWriter = { user: writer.id, tenant: seed.tenant.id };
    return { ...seed, setup, movedIn, movedOut, as, approver, asWriter, future, inScope, allowedFuture, outside };
  }

  it('当前人员范围与历史记录部门必须同时命中；历史 asOf 不能恢复调出人员范围', async () => {
    const get = (path: string) => world.api.request('GET', `/api/tenant/employment${path}`, world.as);
    expect((await get(`/employees/${world.movedIn.employee.id}`)).status).toBe(200);
    expect((await get(`/records/${world.movedIn.hire.id}`)).status).toBe(404);
    expect((await get(`/records/${world.movedOut.hire.id}?asOf=2026-01-01`)).status).toBe(404);
    expect((await get(`/businesses/${world.movedOut.hire.id}`)).status).toBe(404);
    const records = await get(`/employees/${world.movedIn.employee.id}/records`);
    expect(records.status).toBe(200);
    expect(((await records.json()) as { items: { id: string }[] }).items.map((record) => record.id)).toEqual([
      world.movedIn.current.id,
    ]);
  });

  it('列表、员工详情、任职详情及 before/record 嵌套全部裁剪隐藏字段', async () => {
    for (const path of [
      '/employees',
      `/employees/${world.movedIn.employee.id}`,
      `/employees/${world.movedIn.employee.id}/records`,
      `/records/${world.movedIn.current.id}`,
      `/businesses/${world.movedIn.current.id}`,
    ]) {
      const response = await world.api.request('GET', `/api/tenant/employment${path}`, world.as);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('隐藏姓名');
      expect(body).not.toContain('隐藏备注');
      expect(body).not.toContain('"remarks"');
    }
  });

  it('DEC-057：具有审批相关功能身份也不产生员工/任职数据范围', async () => {
    // 审批节点详情的最小披露见 AC-APV-PRM-29；此处证明业务权限本身不产生档案范围。
    const as = { user: world.approver.id, tenant: world.tenant.id };
    const list = await world.api.request('GET', '/api/tenant/employment/employees', as);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [], hasDataPermission: false });
    for (const path of [
      `/employees/${world.movedIn.employee.id}`,
      `/employees/${world.movedIn.employee.id}/records`,
      `/records/${world.movedIn.current.id}`,
      `/businesses/${world.movedIn.current.id}`,
    ]) {
      expect((await world.api.request('GET', `/api/tenant/employment${path}`, as)).status).toBe(404);
    }
  });
  it('继承预览裁剪隐藏字段；导入预览不可借用其他员工或范围外记录', async () => {
    const preview = await world.api.request(
      'POST',
      `/api/tenant/employment/employees/${world.movedIn.employee.id}/preview`,
      {
        ...world.as,
        body: { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-02', fields: {} },
      },
    );
    expect(preview.status).toBe(200);
    const body = await preview.text();
    expect(body).not.toContain('隐藏备注');
    expect(body).not.toContain('"remarks"');
    const denied = await world.api.request(
      'POST',
      `/api/tenant/employment/employees/${world.movedIn.employee.id}/import/forward-update-preview`,
      {
        ...world.as,
        body: {
          items: [
            { operation: 'edit', id: world.movedOut.hire.id, revision: 1, patch: { fields: { place: '禁止借用' } } },
          ],
        },
      },
    );
    expect(denied.status).toBe(404);
  });

  it('只有查看和Preview权限可预览导入新增调动，真实导入仍拒绝且不改变任职', async () => {
    const employeeId = world.inScope.employee.id;
    const body = {
      items: [
        {
          operation: 'create',
          business: {
            kind: 'transfer',
            mode: 'direct',
            effectiveDate: '2026-10-02',
            fields: { place: '只读导入试算' },
          },
        },
      ],
    };
    const employeePath = `/api/tenant/employment/employees/${employeeId}`;
    const before = await world.setup.request('GET', employeePath, world.asAdmin);
    const snapshot = await before.json();
    const preview = await world.api.request('POST', `${employeePath}/import/forward-update-preview`, {
      ...world.as,
      body,
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const result = await preview.text();
    expect(result).toContain('只读导入试算');
    expect(result).not.toContain('隐藏备注');
    expect(result).not.toContain('"remarks"');
    const denied = await world.api.request('POST', `${employeePath}/import`, {
      ...world.as,
      ifMatch: (snapshot as { revision: number }).revision,
      body,
    });
    expect(denied.status).toBe(403);
    const after = await world.setup.request('GET', employeePath, world.asAdmin);
    expect(await after.json()).toEqual(snapshot);
  });

  it('自动向后更新不越过未来记录的部门范围，失败时原记录编辑整体回滚', async () => {
    const path = `/api/tenant/employment/records/${world.movedIn.current.id}`;
    const preview = await world.api.request('POST', `${path}/forward-update-preview`, {
      ...world.as,
      body: { fields: { place: '新的地点' } },
    });
    expect(preview.status).toBe(404);
    expect(await preview.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    const changed = await world.api.request('PATCH', path, {
      ...world.asWriter,
      ifMatch: world.movedIn.current.revision,
      body: { fields: { place: '新的地点' } },
    });
    expect(changed.status).toBe(404);
    expect(await changed.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    const actual = await world.setup.request('GET', path, world.asAdmin);
    expect(actual.status).toBe(200);
    expect(await actual.json()).toMatchObject({
      fields: { place: '可见地点' },
      revision: world.movedIn.current.revision,
    });
    const future = await world.setup.request(
      'GET',
      `/api/tenant/employment/businesses/${world.future.id}`,
      world.asAdmin,
    );
    expect(await future.json()).toMatchObject({ fields: { place: '可见地点' } });
  });
  it('有范围的 forward 写入在同一事务内重验字段权限；预览 changes 不泄露隐藏字段', async () => {
    const path = `/api/tenant/employment/records/${world.inScope.current.id}`;
    const hidden = await world.api.request('POST', `${path}/forward-update-preview`, {
      ...world.as,
      body: { fields: { dimension1: '隐藏字段的新值' } },
    });
    expect(hidden.status).toBe(200);
    expect(await hidden.text()).not.toContain('隐藏字段的新值');
    const changed = await world.api.request('PATCH', path, {
      ...world.asWriter,
      ifMatch: world.inScope.current.revision,
      body: { fields: { place: '允许传播' } },
    });
    expect(changed.status).toBe(200);
    const future = await world.setup.request(
      'GET',
      `/api/tenant/employment/businesses/${world.allowedFuture.id}`,
      world.asAdmin,
    );
    expect(await future.json()).toMatchObject({ fields: { place: '允许传播' } });
  });
  it('任职list的使用用户页面规则按任职创建者生效，不再叠加员工档案范围', async () => {
    const objectCode = MODULE_OBJECTS.employmentRecord.code;
    const policy = await world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${objectCode}/page/${objectCode}.list`,
      {
        ...world.asAdmin,
        ifMatch: 0,
        body: { rules: [{ dimension: 'using_user' }] },
      },
    );
    expect(policy.status).toBe(200);
    const employeeResponse = await world.setup.request('POST', '/api/tenant/employment/employees', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `OWNER_${randomUUID()}`, name: '管理员创建的主档' },
    });
    expect(employeeResponse.status).toBe(201);
    const employee = (await employeeResponse.json()) as { id: string; revision: number };
    const ownRecord = await world.setup.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
      ...world.as,
      ifMatch: employee.revision,
      body: {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId: world.outside.id, place: '本人的任职记录' },
        loginEmail: loginEmailOf(employee.id),
      },
    });
    expect(ownRecord.status).toBe(201);
    const record = (await ownRecord.json()) as { id: string };
    const list = await world.api.request('GET', `/api/tenant/employment/employees/${employee.id}/records`, world.as);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: record.id, fields: { place: '本人的任职记录' } }] });
    // Page override belongs to records only: the employee profile and record detail retain entity scope.
    expect((await world.api.request('GET', `/api/tenant/employment/employees/${employee.id}`, world.as)).status).toBe(
      404,
    );
    expect((await world.api.request('GET', `/api/tenant/employment/records/${record.id}`, world.as)).status).toBe(404);
    for (const id of [world.movedIn.employee.id, randomUUID()]) {
      expect((await world.api.request('GET', `/api/tenant/employment/employees/${id}/records`, world.as)).status).toBe(
        404,
      );
    }
  });
});
