/** AC-TRF-01/02/03/19/20/24/25：真实授权器校验发起方、源员工范围和目标部门范围。 */
import { randomUUID } from 'node:crypto';
import { permissionUserPersonLinks, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
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
const BASE = '/api/tenant/employment/transfers';
const STANDARD = 'TenantBase.CrossDepartmentTransferMultiFormView';
const CUSTOM = 'custom-transfer-access';
const EFFECTIVE_DATE = '2026-10-01';
const INITIATOR_BUTTONS = ['Transfer.Hr', 'Transfer.Manager', 'Transfer.Self'];
const DIRECT_BUTTONS = ['EmploymentRecord.LineOp.Transfer', 'Employment.Tranfer'];

interface Person {
  readonly id: string;
  readonly revision: number;
}
interface Actor {
  readonly user: string;
  readonly tenant: string;
}

async function fixture() {
  const db = database().db;
  const original = await seedPermissionWorld(db);
  const clock = () => new Date(`${EFFECTIVE_DATE}T01:00:00.000Z`);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const world = { ...original, api };
  async function create(path: string, body: object, revision = 0) {
    const response = await setup.request('POST', `/api/tenant/${path}`, {
      ...world.asAdmin,
      ifMatch: revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; employeeRevision: number };
  }
  const org = (name: string) =>
    create('org/organizations', {
      name,
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: world.tenant.id } },
    });
  const inside = await org('调动管理范围内部门');
  const outside = await org('调动管理范围外部门');
  // 本组聚焦部门范围；其他场景排除字段配置只读，DEC-163 的部门必填与留空另有真实表单验收。
  const configured = await setup.request('PUT', `${BASE}/forms/${STANDARD}`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      name: '合成部门范围调动表单',
      group: 'transfer',
      fieldModes: {
        'preset:positionId': 'readonly',
        'preset:directManagerId': 'readonly',
        'preset:dottedManagerId': 'readonly',
      },
    },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);

  async function person(departmentId = inside.id, binding?: Actor, directManagerId?: string): Promise<Person> {
    const employee = await create('employment/employees', { name: '合成调动员工', code: `TRF_${randomUUID()}` });
    if (binding) {
      // 已绑定用户的可信夹具；账号绑定自身的业务验收在 AC-PRM-31/32。
      await withTenant(db, world.tenant.id, (tx) =>
        tx.insert(permissionUserPersonLinks).values({
          tenantId: world.tenant.id,
          userId: binding.user,
          employeeId: employee.id,
        }),
      );
    }
    const hire = await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId, ...(directManagerId ? { directManagerId } : {}) },
        ...(binding ? {} : { loginEmail: loginEmailOf(employee.id) }),
      },
      employee.revision,
    );
    return { id: employee.id, revision: hire.employeeRevision };
  }

  async function actor(label: string, options: { empty?: boolean; role?: string; direct?: boolean } = {}) {
    const user = await addMember(world, label);
    const profile = await createProfile(world, `${label.slice(0, 26)}-${randomUUID()}`);
    const definition = MODULE_OBJECTS.employmentRecord;
    const buttons = definition.buttons
      .filter((button) => ![...INITIATOR_BUTTONS, ...DIRECT_BUTTONS].includes(button.code))
      .map((button) => ({ buttonCode: button.code, level: button.level }));
    buttons.push({ buttonCode: options.role ?? 'Transfer.Hr', level: 'detail' });
    if (options.direct !== false) buttons.push({ buttonCode: 'EmploymentRecord.LineOp.Transfer', level: 'list_row' });
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
        buttons,
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    if (!options.empty) {
      const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
      });
      expect(scope.status).toBe(200);
    }
    return { user: user.id, tenant: world.tenant.id };
  }

  let settingsRevision = 0;
  async function settings(unrestrictTargetDepartment: boolean) {
    const response = await setup.request('PUT', `${BASE}/settings`, {
      ...world.asAdmin,
      ifMatch: settingsRevision,
      body: { unrestrictTargetDepartment, autoPopulate: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    settingsRevision = ((await response.json()) as { revision: number }).revision;
  }
  function transfer(as: Actor, employee: Person, extra: object = {}, preview = false) {
    return api.request('POST', `${BASE}/employees/${employee.id}${preview ? '/preview' : ''}`, {
      ...as,
      ifMatch: employee.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        formId: STANDARD,
        effectiveDate: EFFECTIVE_DATE,
        mode: 'application',
        fields: { departmentId: outside.id },
        ...extra,
      },
    });
  }
  async function currentRevision(employee: Person) {
    const response = await setup.request('GET', `/api/tenant/employment/employees/${employee.id}`, world.asAdmin);
    expect(response.status).toBe(200);
    return ((await response.json()) as { revision: number }).revision;
  }
  return { ...world, setup, inside, outside, actor, person, settings, transfer, currentRevision };
}

describe('AC-TRF-01/02/03/19/20/24/25 调动入口真实权限', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });

  it('AC-TRF-03/19/24：标准表单默认放开目标部门，预览及保存仍只允许范围内员工', async () => {
    const hr = await world.actor('transfer-hr');
    const employee = await world.person();
    const preview = await world.transfer(hr, employee, {}, true);
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await preview.json()).toMatchObject({ fields: { departmentId: world.outside.id } });
    const saved = await world.transfer(hr, employee);
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({ status: 'draft', fields: { departmentId: world.outside.id } });
    const outsider = await world.person(world.outside.id);
    for (const isPreview of [true, false]) {
      const denied = await world.transfer(hr, outsider, { fields: { departmentId: world.inside.id } }, isPreview);
      expect(denied.status).toBe(404);
    }
    expect(await world.currentRevision(outsider)).toBe(outsider.revision);
  });

  it('AC-TRF-19/20：部门候选与提交使用同一开关，关闭后拒绝范围外目标且不产生业务', async () => {
    const hr = await world.actor('transfer-target-scope');
    const employee = await world.person();
    const path = `${BASE}/departments?formId=${STANDARD}&effectiveDate=${EFFECTIVE_DATE}`;
    const open = await world.api.request('GET', path, hr);
    expect(open.status).toBe(200);
    expect(((await open.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
      world.outside.id,
    );
    await world.settings(false);
    try {
      const closed = await world.api.request('GET', path, hr);
      expect(closed.status).toBe(200);
      const ids = ((await closed.json()) as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids).toContain(world.inside.id);
      expect(ids).not.toContain(world.outside.id);
      for (const isPreview of [true, false]) {
        expect((await world.transfer(hr, employee, {}, isPreview)).status).toBe(404);
      }
      expect(await world.currentRevision(employee)).toBe(employee.revision);
    } finally {
      await world.settings(true);
    }
  });

  it('AC-TRF-25：自定义表单在开关开启时仍受目标部门范围约束', async () => {
    const configured = await world.setup.request('PUT', `${BASE}/forms/${CUSTOM}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name: '合成自定义调动表单', group: 'transfer', fieldModes: {} },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const hr = await world.actor('transfer-custom');
    const employee = await world.person();
    const departments = await world.api.request(
      'GET',
      `${BASE}/departments?formId=${CUSTOM}&effectiveDate=${EFFECTIVE_DATE}`,
      hr,
    );
    expect(departments.status).toBe(200);
    const ids = ((await departments.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(world.inside.id);
    expect(ids).not.toContain(world.outside.id);
    for (const isPreview of [true, false]) {
      expect((await world.transfer(hr, employee, { formId: CUSTOM }, isPreview)).status).toBe(404);
    }
    expect(await world.currentRevision(employee)).toBe(employee.revision);
  });

  it('默认空范围不得因调动按钮或标准表单目标部门开关而扩大员工范围', async () => {
    const hr = await world.actor('transfer-empty', { empty: true });
    const employee = await world.person();
    for (const isPreview of [true, false]) expect((await world.transfer(hr, employee, {}, isPreview)).status).toBe(404);
    expect(await world.currentRevision(employee)).toBe(employee.revision);
  });

  it('HR入口回避绑定本人，员工入口必须有独立按钮且仍按本人范围校验', async () => {
    const hr = await world.actor('transfer-own-hr');
    const self = await world.person(world.inside.id, hr);
    expect((await world.transfer(hr, self)).status).toBe(403);
    expect((await world.transfer(hr, self, { initiator: 'employee' })).status).toBe(403);
    expect(await world.currentRevision(self)).toBe(self.revision);
  });

  it('AC-TRF-01：员工只可为绑定本人发起，绑定本身不提供默认数据范围', async () => {
    const employeeActor = await world.actor('transfer-self', { role: 'Transfer.Self' });
    const self = await world.person(world.inside.id, employeeActor);
    const other = await world.person();
    const saved = await world.transfer(employeeActor, self, { initiator: 'employee' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect((await world.transfer(employeeActor, other, { initiator: 'employee' })).status).toBe(403);
    const emptyActor = await world.actor('transfer-self-empty', { role: 'Transfer.Self', empty: true });
    const emptySelf = await world.person(world.inside.id, emptyActor);
    expect((await world.transfer(emptyActor, emptySelf, { initiator: 'employee' })).status).toBe(404);
    expect(await world.currentRevision(emptySelf)).toBe(emptySelf.revision);
  });

  it('AC-TRF-02：经理绑定本人后只可为其团队发起，组织范围不能替代团队关系', async () => {
    const managerActor = await world.actor('transfer-manager', { role: 'Transfer.Manager' });
    const manager = await world.person(world.inside.id, managerActor);
    const subordinate = await world.person(world.inside.id, undefined, manager.id);
    const unrelated = await world.person();
    const saved = await world.transfer(managerActor, subordinate, { initiator: 'manager' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect((await world.transfer(managerActor, unrelated, { initiator: 'manager' })).status).toBe(403);
    expect((await world.transfer(managerActor, manager, { initiator: 'manager' })).status).toBe(403);
    expect(await world.currentRevision(unrelated)).toBe(unrelated.revision);
  });

  it('HR按自己的入口权限读取并修改员工或经理发起的跨范围草稿，不冒充原发起身份', async () => {
    const hr = await world.actor('transfer-followup-hr');
    for (const initiator of ['employee', 'manager'] as const) {
      const actor = await world.actor(`transfer-followup-${initiator}`, {
        role: initiator === 'employee' ? 'Transfer.Self' : 'Transfer.Manager',
      });
      const own = await world.person(world.inside.id, actor);
      const employee = initiator === 'employee' ? own : await world.person(world.inside.id, undefined, own.id);
      const saved = await world.transfer(actor, employee, { initiator });
      expect(saved.status, await saved.clone().text()).toBe(201);
      const business = (await saved.json()) as { id: string; revision: number };
      const path = `/api/tenant/employment/businesses/${business.id}`;
      const read = await world.api.request('GET', path, hr);
      expect(read.status, await read.clone().text()).toBe(200);
      const edited = await world.api.request('PATCH', path, {
        ...hr,
        ifMatch: business.revision,
        body: { fields: { remarks: 'HR依自身授权核对' } },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
      const noRole = await world.actor(`transfer-followup-unrelated-${initiator}`, { role: 'Transfer.Self' });
      expect((await world.api.request('GET', path, noRole)).status).toBe(404);
    }
  });

  it('直接调动需独立按钮，不能只凭发起申请权限改mode绕过审批', async () => {
    const hr = await world.actor('transfer-application-only', { direct: false });
    const employee = await world.person();
    expect((await world.transfer(hr, employee, { mode: 'direct' })).status).toBe(403);
    expect(await world.currentRevision(employee)).toBe(employee.revision);
    const application = await world.transfer(hr, employee);
    expect(application.status, await application.clone().text()).toBe(201);
  });

  it('旧任职写入接口同样拒绝缺少直接调动按钮的调用，不能借Employment.Create绕过', async () => {
    const hr = await world.actor('transfer-generic-application-only', { direct: false });
    const employee = await world.person();
    const denied = await world.api.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
      ...hr,
      ifMatch: employee.revision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: EFFECTIVE_DATE,
        fields: { departmentId: world.inside.id },
      },
    });
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await world.currentRevision(employee)).toBe(employee.revision);
  });

  it('R1-T05测试表单标识不能从公开预览接口绕过真实调动配置', async () => {
    const hr = await world.actor('transfer-generic-form');
    const employee = await world.person();
    const preview = await world.api.request('POST', `/api/tenant/employment/employees/${employee.id}/preview`, {
      ...hr,
      body: {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: EFFECTIVE_DATE,
        formId: 'readonly-custom',
        fields: { departmentId: world.inside.id },
      },
    });
    expect([400, 403]).toContain(preview.status);
    for (const formId of ['standard', 'readonly-custom', 'hidden-custom', 'omitted-custom', 'ungrouped-custom']) {
      for (const isPreview of [true, false]) {
        const bypass = await world.transfer(
          hr,
          employee,
          { formId, fields: { departmentId: world.inside.id } },
          isPreview,
        );
        expect(bypass.status, `真实调动入口必须拒绝旧测试表单 ${formId}`).toBe(400);
      }
    }
    expect(await world.currentRevision(employee)).toBe(employee.revision);
  });

  it('幂等重放重新校验当前人员范围；撤销范围后不返回先前保存的调动内容', async () => {
    const hr = await world.actor('transfer-replay-scope');
    const employee = await world.person();
    const options = {
      ...hr,
      ifMatch: employee.revision,
      idempotencyKey: randomUUID(),
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        effectiveDate: EFFECTIVE_DATE,
        mode: 'application',
        fields: { departmentId: world.outside.id, remarks: '重放不得泄露此字段' },
      },
    };
    const path = `${BASE}/employees/${employee.id}`;
    const saved = await world.api.request('POST', path, options);
    expect(saved.status, await saved.clone().text()).toBe(201);
    const revoked = await world.api.request('PUT', `/api/tenant/permission/scopes/${hr.user}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 1,
      body: { kind: 'org_range', orgRanges: [] },
    });
    expect(revoked.status).toBe(200);
    const replay = await world.api.request('POST', path, options);
    expect(replay.status).toBe(404);
    expect(await replay.text()).not.toContain('重放不得泄露此字段');
  });

  it('标准表单跨范围保存后关闭部门开关，原命令重放不能绕过当前目标范围限制', async () => {
    const hr = await world.actor('transfer-replay-setting');
    const employee = await world.person();
    const options = {
      ...hr,
      ifMatch: employee.revision,
      idempotencyKey: randomUUID(),
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        effectiveDate: EFFECTIVE_DATE,
        mode: 'application',
        fields: { departmentId: world.outside.id },
      },
    };
    const path = `${BASE}/employees/${employee.id}`;
    const saved = await world.api.request('POST', path, options);
    expect(saved.status, await saved.clone().text()).toBe(201);
    await world.settings(false);
    try {
      expect((await world.api.request('POST', path, options)).status).toBe(404);
    } finally {
      await world.settings(true);
    }
  });

  it('直接调动命令重放仍受当前允许直接调动开关控制', async () => {
    const hr = await world.actor('transfer-replay-direct');
    const employee = await world.person();
    const options = {
      ...hr,
      ifMatch: employee.revision,
      idempotencyKey: randomUUID(),
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        effectiveDate: EFFECTIVE_DATE,
        mode: 'direct',
        fields: { departmentId: world.inside.id },
      },
    };
    const path = `${BASE}/employees/${employee.id}`;
    const saved = await world.api.request('POST', path, options);
    expect(saved.status, await saved.clone().text()).toBe(201);
    const disabled = await world.setup.request('PUT', '/api/tenant/employment/settings', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { allowDirectTransfer: false },
    });
    expect(disabled.status).toBe(200);
    try {
      const replay = await world.api.request('POST', path, options);
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ error: { message: '本租户调动须走审批' } });
    } finally {
      const enabled = await world.setup.request('PUT', '/api/tenant/employment/settings', {
        ...world.asAdmin,
        ifMatch: 1,
        body: { allowDirectTransfer: true },
      });
      expect(enabled.status).toBe(200);
    }
  });

  it('切换租户不能访问另一租户的员工或目标部门', async () => {
    const foreign = await fixture();
    const foreignEmployee = await foreign.person();
    const hr = await world.actor('transfer-isolation');
    expect((await world.transfer(hr, foreignEmployee)).status).toBe(404);
    const employee = await world.person();
    const result = await world.transfer(hr, employee, { fields: { departmentId: foreign.inside.id } });
    expect([400, 404]).toContain(result.status);
    expect(await world.currentRevision(employee)).toBe(employee.revision);
  });
});
