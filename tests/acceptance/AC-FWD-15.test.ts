/**
 * AC-FWD-15：向后更新碰到操作人范围外部门的后续记录（DEC-178，`11` §19 / Q-M0-33）。
 * 后续记录按 DEC-177 对操作人可见即改写并写审计；不可见则整单拒绝，保留 DEC-084 的 LINKED_RECORD_OUT_OF_SCOPE。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
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
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');
type Created = { id: string; revision: number; employeeRevision: number };
type Identity = { user: string; tenant: string };

async function fixture() {
  const db = database().db;
  const seed = await seedPermissionWorld(db);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  async function send(path: string, body: unknown, revision = 0, as: Identity = seed.asAdmin) {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...as, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Created;
  }
  const org = (name: string) =>
    send('org/organizations', { name, establishedOn: '2025-01-01', parents: { admin: { parentId: seed.tenant.id } } });
  const inside = await org('联动范围内部门');
  const outside = await org('联动范围外部门');
  const profile = await createProfile(seed, `linked-writer-${randomUUID().slice(0, 8)}`);
  for (const definition of [MODULE_OBJECTS.employee, MODULE_OBJECTS.employmentRecord]) {
    const response = await setObjectPermission(
      seed,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
        buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(seed, [profile.id]);
  const user = await addMember(seed, 'linked-writer');
  expect((await grant(seed, user.id, profile.id)).status).toBe(201);
  const writer: Identity = { user: user.id, tenant: seed.tenant.id };
  async function forwardAudits(objectId: string) {
    return withTenant(db, seed.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT actor_user_id AS actor, after FROM audit_events
        WHERE tenant_id=${seed.tenant.id} AND object_id=${objectId} AND action='employment.forward-update'`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        actor: string;
        after: Record<string, unknown>;
      }[];
    });
  }
  const business = (id: string) =>
    setup
      .request('GET', `/api/tenant/employment/businesses/${id}`, seed.asAdmin)
      .then(async (response) => (await response.json()) as { revision: number; fields: { place: string } });
  return { db, seed, api, setup, send, inside, outside, writer, forwardAudits, business };
}

describe('AC-FWD-15 DEC-178 向后更新：后续记录可见即改写，不可见整单拒绝', () => {
  it('员工当前在范围内：范围外部门的未来生效记录与申请都按值匹配改写，并以操作人写审计', async () => {
    const world = await fixture();
    const { send, inside, outside, writer, seed } = world;
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${writer.user}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    const person = await send('employment/employees', { code: `F15_${randomUUID()}`, name: '联动合成员工' });
    const hire = await send(
      `employment/employees/${person.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId: inside.id, place: '原地点' },
        loginEmail: loginEmailOf(person.id),
      },
      person.revision,
    );
    const future = await send(
      `employment/employees/${person.id}/businesses`,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: outside.id } },
      hire.employeeRevision,
    );
    const application = await send(
      `employment/employees/${person.id}/businesses`,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-12-01', fields: { departmentId: outside.id } },
      future.employeeRevision,
    );
    expect((await world.business(future.id)).fields.place).toBe('原地点');
    const path = `/api/tenant/employment/records/${hire.id}`;
    const preview = await world.api.request('POST', `${path}/forward-update-preview`, {
      ...writer,
      body: { fields: { place: '新地点' } },
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const plan = (await preview.json()) as { changes: { businessId: string }[] };
    expect(plan.changes.map((change) => change.businessId)).toEqual([future.id, application.id]);
    const changed = await world.api.request('PATCH', path, {
      ...writer,
      ifMatch: hire.revision,
      body: { fields: { place: '新地点' } },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    for (const target of [future, application]) {
      expect((await world.business(target.id)).fields.place).toBe('新地点');
      expect(await world.forwardAudits(target.id)).toEqual([{ actor: writer.user, after: { place: '新地点' } }]);
    }
  });

  it('后续记录对操作人不可见（使用用户范围、他人创建）：整单拒绝并回滚源记录', async () => {
    const world = await fixture();
    const { send, inside, writer, seed } = world;
    const objectCode = MODULE_OBJECTS.employmentRecord.code;
    const policy = await world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${objectCode}/entity/${objectCode}`,
      { ...seed.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    const person = await send('employment/employees', { code: `F15_${randomUUID()}`, name: '联动合成员工' });
    const hire = await send(
      `employment/employees/${person.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId: inside.id, place: '原地点' },
        loginEmail: loginEmailOf(person.id),
      },
      person.revision,
    );
    // 操作人自己创建的当前记录（可见、可编辑）与管理员创建的未来记录（不可见）。
    const own = await send(
      `employment/employees/${person.id}/businesses`,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: inside.id } },
      hire.employeeRevision,
      writer,
    );
    const hidden = await send(
      `employment/employees/${person.id}/businesses`,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: inside.id } },
      own.employeeRevision,
    );
    expect((await world.business(hidden.id)).fields.place).toBe('原地点');
    const path = `/api/tenant/employment/records/${own.id}`;
    const preview = await world.api.request('POST', `${path}/forward-update-preview`, {
      ...writer,
      body: { fields: { place: '新地点' } },
    });
    expect(preview.status, await preview.clone().text()).toBe(404);
    expect(await preview.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    const before = await world.business(own.id);
    const changed = await world.api.request('PATCH', path, {
      ...writer,
      ifMatch: before.revision,
      body: { fields: { place: '新地点' } },
    });
    expect(changed.status).toBe(404);
    expect(await changed.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    expect(await world.business(own.id)).toMatchObject({ revision: before.revision, fields: { place: '原地点' } });
    expect((await world.business(hidden.id)).fields.place).toBe('原地点');
    expect(await world.forwardAudits(hidden.id)).toEqual([]);
  });
});
