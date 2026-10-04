/**
 * AC-ORG-17 / AC-ORG-18（DEC-135，`10` §14）：组织负责人、HRBP、店长的候选人与服务端保存校验都是
 * 同租户、生效日在职、内部员工（有人员档案，DEC-128），不按操作人数据范围过滤；
 * 人员选择器只返回姓名、工号、部门等最少字段（DEC-057）。
 */
import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { orgPeopleWorld, TODAY } from './AC-ORG-people-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const PEOPLE_FIELDS = ['personInChargeId', 'hrbpId', 'shopOwnerId'] as const;

/** E1 在职；E2 生效日已离职；E3 只建档未入职；另一租户的 E4 在职。 */
async function people(label: string) {
  const world = await orgPeopleWorld(testDb().db, label);
  const department = await world.org('候选人所在部门');
  const active = await world.hire('在职候选人', { departmentId: department.id });
  const leaver = await world.hire('离职候选人', { departmentId: department.id });
  await world.business(leaver.id, { kind: 'leave', mode: 'direct', lastWorkDate: TODAY }, leaver.revision);
  const pending = await world.employee('待入职候选人');
  const foreignWorld = await orgPeopleWorld(testDb().db, `${label}foreign`);
  const foreignDepartment = await foreignWorld.org('外租户部门');
  const foreign = await foreignWorld.hire('外租户在职员工', { departmentId: foreignDepartment.id });
  return { world, department, active, leaver, pending, foreign };
}

function expectIneligible(response: Response, field: string) {
  expect(response.status).toBe(400);
  return expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'VALIDATION_FAILED',
      details: { reason: 'PERSON_NOT_ELIGIBLE', fields: { [field]: expect.any(String) } },
    },
  });
}

describe('AC-ORG-17 负责人 / HRBP / 店长保存校验（DEC-135）', () => {
  it('生效日在职的本租户员工可以保存为负责人、HRBP、店长', async () => {
    const { world, active } = await people('org17save');
    const org = await world.org('有负责人部门', world.tenant.id, {
      personInChargeId: active.id,
      hrbpId: active.id,
      shopOwnerId: active.id,
    });
    expect(org).toMatchObject({ personInChargeId: active.id, hrbpId: active.id, shopOwnerId: active.id });
  });

  it('生效日已离职、尚未入职、其他租户或不存在的人员一律 400，组织不写入', async () => {
    const { world, leaver, pending, foreign } = await people('org17reject');
    const org = await world.org('校验人员部门');
    const cases: [string, string][] = [
      ['personInChargeId', leaver.id],
      ['hrbpId', pending.id],
      ['shopOwnerId', foreign.id],
      ['personInChargeId', randomUUID()],
    ];
    for (const [field, id] of cases) {
      await expectIneligible(await world.patchOrg(org, { [field]: id, effectiveDate: '2026-10-02' }), field);
    }
    const created = await world.call('POST', 'org/organizations', {
      ifMatch: 0,
      body: { name: '离职负责人部门', parents: { admin: { parentId: world.tenant.id } }, hrbpId: leaver.id },
    });
    expect(created.status).toBe(400);
    expect((await world.orgsAt('2026-10-02')).get(org.id)).toMatchObject({ revision: 1, personInChargeId: null });
  });

  it('按版本生效日判断在职：离职生效日之前的变更可以引用该员工，之后不行', async () => {
    const { world, leaver } = await people('org17date');
    const org = await world.org('按日期校验部门');
    const sameDay = await world.patchOrg(org, { personInChargeId: leaver.id, effectiveDate: TODAY });
    expect(sameDay.status, await sameDay.clone().text()).toBe(200);
    await expectIneligible(
      await world.patchOrg({ id: org.id, revision: 2 }, { hrbpId: leaver.id, effectiveDate: '2026-10-02' }),
      'hrbpId',
    );
  });

  it('沿用的原值不随无关变更重新校验：负责人离职后仍可改名', async () => {
    const { world, leaver } = await people('org17inherit');
    const org = await world.org('沿用负责人部门');
    expect((await world.patchOrg(org, { personInChargeId: leaver.id, effectiveDate: TODAY })).status).toBe(200);
    const renamed = await world.patchOrg(
      { id: org.id, revision: 2 },
      { name: '改名部门', effectiveDate: '2026-10-05' },
    );
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: '改名部门', personInChargeId: leaver.id });
  });
});

describe('AC-ORG-18 负责人等字段的人员选择器（DEC-135、DEC-057）', () => {
  it('只列本租户生效日在职员工，只返回姓名、工号、部门；可按关键字检索', async () => {
    const { world, department, active, leaver, pending, foreign } = await people('org18picker');
    const response = await world.call('GET', `org/person-candidates?asOf=2026-10-02`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(active.id);
    for (const excluded of [leaver.id, pending.id, foreign.id]) expect(ids).not.toContain(excluded);
    const item = body.items.find((candidate) => candidate.id === active.id)!;
    expect(Object.keys(item).sort()).toEqual(['code', 'departmentId', 'departmentName', 'id', 'name']);
    expect(item).toEqual({
      id: active.id,
      name: '在职候选人',
      code: active.code,
      departmentId: department.id,
      departmentName: department.name,
    });
    const byKeyword = await world.call(
      'GET',
      `org/person-candidates?asOf=2026-10-02&keyword=${encodeURIComponent('在职候')}`,
    );
    expect(((await byKeyword.json()) as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([active.id]);
    const before = await world.call('GET', `org/person-candidates?asOf=${TODAY}`);
    expect(((await before.json()) as { items: { id: string }[] }).items.map((row) => row.id)).toContain(leaver.id);
  });
});

describe('AC-ORG-17/18 不按操作人数据范围过滤（真实授权器）', () => {
  async function scopedOperator(world: PermissionWorld, orgId: string, editable: readonly string[]) {
    const profile = await createProfile(world, `org-people-${randomUUID().slice(0, 8)}`);
    const definition = MODULE_OBJECTS.organization;
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: true,
          edit: !field.system && editable.includes(field.code),
        })),
        buttons: [],
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, 'org-people-operator');
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId, includeDescendants: false }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    return { user: user.id, tenant: world.tenant.id };
  }

  it('范围只含本部门的操作人也能选到、保存范围外的在职员工；没有人员字段编辑权的人不能用选择器', async () => {
    const db = testDb().db;
    const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
    const seed = await seedPermissionWorld(db);
    const world: PermissionWorld = { ...seed, api: tenantApi(db, { authorize: undefined, clock }) };
    const setup = tenantApi(db, { clock });
    const create = async (path: string, body: object, ifMatch = 0) => {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string; code: string; revision: number; employeeRevision: number };
    };
    const parents = { admin: { parentId: world.tenant.id } };
    const managed = await create('org/organizations', { name: '操作人管理部门', parents });
    const outside = await create('org/organizations', { name: '范围外部门', parents });
    const employee = await create('employment/employees', {
      code: `OUT_${randomUUID().slice(0, 8)}`,
      name: '范围外员工',
    });
    await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: TODAY,
        fields: { employType: 'internal', departmentId: outside.id },
      },
      employee.revision,
    );
    const operator = await scopedOperator(world, managed.id, [...PEOPLE_FIELDS, 'effectiveDate']);
    const picker = await world.api.request('GET', `/api/tenant/org/person-candidates?asOf=2026-10-02`, operator);
    expect(picker.status, await picker.clone().text()).toBe(200);
    expect(((await picker.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toContain(employee.id);
    const saved = await world.api.request('PATCH', `/api/tenant/org/organizations/${managed.id}`, {
      ...operator,
      ifMatch: managed.revision,
      body: { personInChargeId: employee.id, effectiveDate: '2026-10-02' },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ personInChargeId: employee.id });
    const viewer = await scopedOperator(world, managed.id, []);
    const denied = await world.api.request('GET', `/api/tenant/org/person-candidates`, viewer);
    expect(denied.status).toBe(403);
  });
});
