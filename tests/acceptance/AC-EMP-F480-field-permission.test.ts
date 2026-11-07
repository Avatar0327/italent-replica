/** F-480 返工：traineeStartDate 登记进任职记录字段目录，真实授权器下可授查看、撤销即裁剪、范围外不可读。 */
import { randomUUID } from 'node:crypto';
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
const FIELD = 'traineeStartDate';
const AT = '2026-10-01';

async function fixture() {
  const world = await seedPermissionWorld(database().db);
  const clock = () => new Date(`${AT}T01:00:00.000Z`);
  const api = tenantApi(database().db, { authorize: undefined, clock });
  const setup = tenantApi(database().db, { clock });
  const post = async (path: string, body: object, revision = 0) => {
    const r = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch: revision, body });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { id: string; revision: number; employeeRevision: number };
  };
  const dept = await post('org/organizations', {
    name: '合成转正部门',
    establishedOn: '2000-01-01',
    parents: { admin: { parentId: world.tenant.id } },
  });
  const employee = await post('employment/employees', { name: '合成实习生', code: `INT_${randomUUID()}` });
  const hire = await post(
    `employment/employees/${employee.id}/businesses`,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { employType: 'intern', departmentId: dept.id },
      loginEmail: loginEmailOf(employee.id),
    },
    employee.revision,
  );
  const reg = await post(
    `employment/interns/${employee.id}/regularize`,
    { effectiveDate: AT, departmentId: dept.id, probation: false },
    hire.employeeRevision,
  );
  const definition = MODULE_OBJECTS.employmentRecord;
  async function actor(label: string, scoped: boolean) {
    const user = await addMember(world, label);
    const profile = await createProfile(world, `${label}-${randomUUID()}`);
    const save = (hidden: string[]) =>
      setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hidden.includes(f.code), edit: false })),
          buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        definition.code,
      );
    expect((await save([])).status).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    if (scoped) {
      const scope = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: dept.id, includeDescendants: false }] },
      });
      expect(scope.status).toBe(200);
    }
    return { as: { user: user.id, tenant: world.tenant.id }, save };
  }
  const read = (as: { user: string; tenant: string }) =>
    api.request('GET', `/api/tenant/employment/records/${reg.id}?asOf=${AT}`, as);
  return { actor, read };
}

describe('AC-EMP-F480 traineeStartDate 字段权限', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });

  it('F480-P：字段目录登记为只读系统字段——有权者读到实习开始日，撤销查看后被裁剪', async () => {
    const viewer = await world.actor('f480-viewer', true);
    const allowed = await world.read(viewer.as);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(await allowed.json()).toMatchObject({ [FIELD]: '2025-01-01' });
    expect((await viewer.save([FIELD])).status).toBe(200);
    const revoked = await world.read(viewer.as);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).not.toHaveProperty(FIELD);
  });

  it('F480-P：任职记录对象定义里 traineeStartDate 是系统字段（不可授编辑）', () => {
    const field = MODULE_OBJECTS.employmentRecord.fields.find((f) => f.code === FIELD);
    expect(field).toMatchObject({ code: FIELD, system: true });
  });

  it('F480-P：范围外的人读不到该记录', async () => {
    const outsider = await world.actor('f480-outsider', false);
    const response = await world.read(outsider.as);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('2025-01-01');
  });
});
