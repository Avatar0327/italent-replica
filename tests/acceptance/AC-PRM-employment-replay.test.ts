/** AC-PRM-22/29：幂等响应也要按当前范围及自动向后更新的实际权限重验。 */
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
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();
const OBJECT = MODULE_OBJECTS.employmentRecord;

async function fixture() {
  const db = database().db;
  const seed = await seedPermissionWorld(db);
  const clock = () => new Date('2026-10-01T01:00:00.000Z');
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  async function create(path: string, body: unknown, revision = 0) {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, ifMatch: revision, body });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; revision: number; employeeRevision: number };
  }
  const org = (name: string) =>
    create('org/organizations', {
      name,
      establishedOn: '2025-01-01',
      parents: { admin: { parentId: seed.tenant.id } },
    });
  const inside = await org('重放范围内');
  const outside = await org('重放范围外');
  const employee = await create('employment/employees', { code: `REPLAY_${randomUUID()}`, name: '合成员工' });
  const hire = await create(
    `employment/employees/${employee.id}/businesses`,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-01-01',
      fields: { departmentId: inside.id, place: '旧地点' },
      loginEmail: loginEmailOf(employee.id),
    },
    employee.revision,
  );
  const future = await create(
    `employment/employees/${employee.id}/businesses`,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-12-01',
      fields: { departmentId: outside.id },
    },
    hire.employeeRevision,
  );
  const user = await addMember(seed, 'replay-writer');
  const profile = await createProfile(seed, `replay-${randomUUID()}`);
  async function permissions(update = true, editablePlace = true) {
    expect(
      (
        await setObjectPermission(
          seed,
          profile,
          {
            dataOperations: { create: true, update, delete: true },
            fields: OBJECT.fields.map((field) => ({
              fieldCode: field.code,
              view: true,
              edit: !field.system && (field.code !== 'place' || editablePlace),
            })),
            buttons: OBJECT.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
          },
          OBJECT.code,
        )
      ).status,
    ).toBe(200);
  }
  await permissions();
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: seed.tenant.id };
  async function scope(orgs: string[], revision: number) {
    expect(
      (
        await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
          ...seed.asAdmin,
          ifMatch: revision,
          body: { kind: 'org_range', orgRanges: orgs.map((orgId) => ({ orgId, includeDescendants: false })) },
        })
      ).status,
    ).toBe(200);
  }
  await scope([inside.id, outside.id], 0);
  return { ...seed, api, setup, inside, outside, employee, hire, future, as, permissions, scope };
}

describe('AC-PRM 任职安全重放', () => {
  it('同键重放重验首次向后更新的所有目标；范围收缩后拒绝并且不再次写入', async () => {
    const world = await fixture();
    const path = `/api/tenant/employment/records/${world.hire.id}`;
    const request = {
      ...world.as,
      ifMatch: world.hire.revision,
      idempotencyKey: randomUUID(),
      body: { fields: { place: '首次传播' } },
    };
    const first = await world.api.request('PATCH', path, request);
    expect(first.status).toBe(200);
    // DEC-178（F-015）：收缩到员工当前部门后，范围外的后续申请按 DEC-177 仍可见，重放照常通过、不再次写入。
    await world.scope([world.inside.id], 1);
    expect((await world.api.request('PATCH', path, request)).status).toBe(200);
    // 再收缩到只剩后续申请的部门：源记录已不在写入范围内，重放拒绝。
    await world.scope([world.outside.id], 2);
    const replay = await world.api.request('PATCH', path, request);
    expect(replay.status).toBe(404);
    const saved = await world.setup.request(
      'GET',
      `/api/tenant/employment/businesses/${world.future.id}`,
      world.asAdmin,
    );
    expect(await saved.json()).toMatchObject({ revision: world.future.revision + 1, fields: { place: '首次传播' } });
  });

  it('创建命令的重放不能越过已撤销的后续记录编辑权限', async () => {
    const world = await fixture();
    const path = `/api/tenant/employment/employees/${world.employee.id}/businesses`;
    const request = {
      ...world.as,
      ifMatch: world.future.employeeRevision,
      idempotencyKey: randomUUID(),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-08-01', fields: { place: '创建后传播' } },
    };
    expect((await world.api.request('POST', path, request)).status).toBe(201);
    await world.permissions(false);
    expect((await world.api.request('POST', path, request)).status).toBe(403);
  });

  it('当前对象已移入范围也不能重放包含旧范围外部门的原始响应', async () => {
    const world = await fixture();
    const path = `/api/tenant/employment/businesses/${world.future.id}`;
    const request = {
      ...world.as,
      ifMatch: world.future.revision,
      idempotencyKey: randomUUID(),
      body: { fields: { place: '旧部门的快照' } },
    };
    const first = await world.api.request('PATCH', path, request);
    expect(first.status).toBe(200);
    const updated = (await first.json()) as { revision: number };
    expect(
      (
        await world.setup.request('PATCH', path, {
          ...world.asAdmin,
          ifMatch: updated.revision,
          body: { fields: { departmentId: world.inside.id } },
        })
      ).status,
    ).toBe(200);
    await world.scope([world.inside.id], 1);
    expect((await world.api.request('GET', path, world.as)).status).toBe(200);
    expect((await world.api.request('PATCH', path, request)).status).toBe(404);
  });

  it('字段编辑权撤销后同键拒绝；删除成功的对象仍可合法同键重放', async () => {
    const world = await fixture();
    const path = `/api/tenant/employment/businesses/${world.future.id}`;
    const request = {
      ...world.as,
      ifMatch: world.future.revision,
      idempotencyKey: randomUUID(),
      body: { fields: { place: '字段权限回查' } },
    };
    const first = await world.api.request('PATCH', path, request);
    expect(first.status).toBe(200);
    const updated = (await first.json()) as { revision: number };
    await world.permissions(true, false);
    expect((await world.api.request('PATCH', path, request)).status).toBe(403);
    const deletion = { ...world.as, ifMatch: updated.revision, idempotencyKey: randomUUID() };
    const deleted = await world.api.request('DELETE', path, deletion);
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json();
    const replay = await world.api.request('DELETE', path, deletion);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(deletedBody);
  });
});
