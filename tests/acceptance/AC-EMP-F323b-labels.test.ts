/**
 * F-323b（DEC-706）：任职存人员类别字典 ID 后，员工自助与审计日志按字典名称显示，不显示 UUID。
 * - 员工自助：本人任职（/profile）与调动预览原值（beforeLabels）带 employmentType 的名称；
 * - 审计：编辑任职改人员类别，字段级日志「人员类别:从【旧名】修改为【新名】」。
 * 只用合成人员与合成类别。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin, type ApprovalWorld } from './AC-APV-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { employmentSession, EMP_TODAY } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import {
  employmentTypeOption,
  employmentTypePermission,
  employmentTypeRow,
} from '../../apps/web/smoke/employment-type-fixtures.js';

const database = useTestDb();
const TYPES = '/api/tenant/employment/employment-types';

async function createType(w: ApprovalWorld, name: string) {
  return w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', TYPES, {
      ifMatch: 0,
      body: { name, displayOrder: 1, effectiveDate: '2018-01-01' },
    }),
    201,
  );
}

describe('AC-EMP-F323b 员工自助人员类别显示名称', () => {
  it('本人任职与调动预览原值都给出人员类别名称；名称随字典改名取当前名', async () => {
    const w = await approvalWorld(database().db, 'f323b-self');
    const api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
    const type = await createType(w, '合成类别甲');
    const org = await w.org('合成部门');
    const target = await w.org('合成目标部门');
    const self = await w.person('合成本人', org, { employmentType: type.id });
    const admin = await permissionAdmin(w);
    const profile = await createProfile(admin, 'employee_self_service');
    await w.json(
      await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: [
            { fieldCode: 'effectiveDate', view: true, edit: true },
            { fieldCode: 'departmentId', view: true, edit: true },
            { fieldCode: 'employmentType', view: true, edit: false },
          ],
          buttons: ['Transfer.Self', 'Employment.Create', 'Employment.Submit'].map((buttonCode) => ({
            buttonCode,
            level: 'detail',
          })),
        },
        'TenantBase.EmploymentRecord',
      ),
    );
    const request = (path: string, body?: unknown) =>
      api.request(body ? 'POST' : 'GET', `/api/tenant/self-service${path}`, { ...w.as(self.userId), body });

    const own = await w.json<{ record: { fields: Record<string, unknown>; fieldLabels: Record<string, string> } }>(
      await request('/profile'),
    );
    expect(own.record.fields.employmentType).toBe(type.id);
    expect(own.record.fieldLabels).toMatchObject({ employmentType: '合成类别甲' });

    const preview = await w.json<{ beforeLabels: Record<string, string>; valueLabels: Record<string, string> }>(
      await request('/transfer/preview', { effectiveDate: '2026-10-19', fields: { departmentId: target } }),
    );
    expect(preview.beforeLabels).toMatchObject({ employmentType: '合成类别甲' });
    expect(preview.valueLabels).toMatchObject({ employmentType: '合成类别甲' });

    const renamed = await w.request(w.hr.id, 'PUT', `${TYPES}/${type.id}`, {
      ifMatch: type.revision,
      body: { name: '合成类别甲（改）' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const again = await w.json<{ record: { fieldLabels: Record<string, string> } }>(await request('/profile'));
    expect(again.record.fieldLabels).toMatchObject({ employmentType: '合成类别甲（改）' });
  });
});

describe('AC-EMP-F323b 审计日志人员类别显示名称', () => {
  it('编辑任职改人员类别：日志「人员类别:从【旧名】修改为【新名】」，原值保留 ID', async () => {
    const { db } = database();
    const session = await employmentSession(db, 'f323b-audit');
    const create = async (name: string) => {
      const response = await session.request('POST', '/employment-types', {
        ifMatch: 0,
        body: { name, displayOrder: 1, effectiveDate: '2018-01-01' },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const from = await create('合成审计类别旧');
    const to = await create('合成审计类别新');
    const department = await session.org('合成审计部门', { establishedOn: '2026-01-01' });
    const employee = await session.employee('审计类别员工');
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: department.id, employmentType: from },
      },
      employee.revision,
    );
    const edited = await session.request('PATCH', `/records/${hire.id}`, {
      ifMatch: hire.revision,
      body: { fields: { employmentType: to } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);

    const audit = auditApi(db, `${EMP_TODAY}T01:00:00.000Z`);
    const as = { user: session.user.id, tenant: session.tenant.id };
    const { items } = await audit.dataChanges(as, {
      objectType: 'employment-record',
      objectId: hire.id,
      operation: 'update',
    });
    const log = items[0]!;
    expect(log.content).toContain('人员类别:从【合成审计类别旧】修改为【合成审计类别新】');
    expect(log.changes).toContainEqual(
      expect.objectContaining({
        field: 'employmentType',
        from,
        to,
        fromText: '合成审计类别旧',
        toText: '合成审计类别新',
      }),
    );
  });
});

describe('AC-EMP-F323b 前端夹具与真实接口一致', () => {
  it('管理员读人员类别对象的返回、列表行与选项的键集合都等于夹具', async () => {
    const { db } = database();
    const session = await employmentSession(db, 'f323b-fixture');
    const clock = () => new Date(`${EMP_TODAY}T01:00:00Z`);
    const api = tenantApi(db, { authorize: undefined, clock });
    const adminRecord = await bootstrapTenantAdmin(db, { tenantId: session.tenant.id, userId: session.user.id }, cmd());
    const asAdmin = { tenant: session.tenant.id, user: session.user.id };
    const seed = { db, tenant: session.tenant, admin: session.user, adminRecord, api, asAdmin };
    // 设置管理员：人员类别对象全部字段可看可改、增删改与启停按钮齐全（同 standard_hr_admin 的授权口径）
    const manager = await addMember(seed, '人员类别设置管理员');
    const profile = await createProfile(seed, 'f323b-type-admin');
    const object = MODULE_OBJECTS.employmentType;
    const full = {
      dataOperations: { create: true, update: true, delete: true },
      fields: object.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
      buttons: object.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
    };
    expect((await setObjectPermission(seed, profile, full, object.code)).status).toBe(200);
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, manager.id, profile.id)).status).toBe(201);
    const as = (method: string, path: string, body?: unknown, ifMatch?: number) =>
      api.request(method, path, { tenant: session.tenant.id, user: manager.id, body, ifMatch });
    const permission = await as('GET', '/api/tenant/permission/me/objects/TenantBase.EmploymentType');
    expect(permission.status).toBe(200);
    const actual = (await permission.json()) as typeof employmentTypePermission;
    expect({ ...actual, buttons: [...actual.buttons].sort(byButton) }).toEqual({
      ...employmentTypePermission,
      buttons: [...employmentTypePermission.buttons].sort(byButton),
    });
    const created = await as(
      'POST',
      '/api/tenant/employment/employment-types',
      { name: '合成夹具类别', displayOrder: 5, effectiveDate: '2018-01-01' },
      0,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const list = (await (await as('GET', '/api/tenant/employment/employment-types?view=all')).json()) as {
      items: object[];
    };
    for (const item of list.items) expect(Object.keys(item).sort()).toEqual(Object.keys(employmentTypeRow()).sort());
    // 选项接口按任职查看权开放（员工表单用），用任职会话读
    const optionResponse = await session.request('GET', '/employment-types/options');
    expect(optionResponse.status, await optionResponse.clone().text()).toBe(200);
    const options = (await optionResponse.json()) as { items: object[] };
    expect(options.items.length).toBeGreaterThan(0);
    for (const item of options.items)
      expect(Object.keys(item).sort()).toEqual(Object.keys(employmentTypeOption()).sort());
  });
});
const byButton = (a: { buttonCode: string }, b: { buttonCode: string }) => a.buttonCode.localeCompare(b.buttonCode);
