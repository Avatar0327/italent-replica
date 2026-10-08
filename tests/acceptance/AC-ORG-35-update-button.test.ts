/**
 * S1-P2-03 / AC-ORG-35（权限口径 AC-PRM-19 / 20）：组织变更 PATCH、其同键缓存重放与在途提醒 employment-preview
 * 都要求组织对象的「update@detail」按钮；只有对象更新、字段与数据范围权限、没有按钮 → 403，首发与重放一致，
 * 任职不写入。按钮齐备时同一请求 200 并追加组织调整，重放返回同一结果。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const CLOCK = () => new Date('2026-10-01T01:00:00Z');
const UPDATE_BUTTON = { buttonCode: 'update', level: 'detail' };
const ORG = '/api/tenant/org/organizations';

/** 把任职夹具的会话用户开通为租户管理员，走真实授权器配置身份（同 AC-APV-support.permissionAdmin）。 */
async function permissionWorld(w: ActivationWorld): Promise<PermissionWorld> {
  const tenantId = w.session.tenant.id;
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId, userId: w.session.user.id }, cmd());
  return {
    db: w.db,
    tenant: w.session.tenant,
    admin: w.session.user,
    adminRecord,
    api: tenantApi(w.db, { authorize: undefined, clock: CLOCK }),
    asAdmin: { user: w.session.user.id, tenant: tenantId },
  };
}

/** 组织与任职记录两个对象都有更新、全部字段与给定组织范围的权限；组织按钮按用例给定。 */
async function actor(world: PermissionWorld, orgIds: string[], buttons: { buttonCode: string; level: string }[]) {
  const profile = await createProfile(world, `org35-${randomUUID().slice(0, 8)}`);
  for (const definition of [MODULE_OBJECTS.organization, MODULE_OBJECTS.employmentRecord]) {
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
        buttons: definition === MODULE_OBJECTS.organization ? buttons : [],
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, 'org35-actor');
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: false })) },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  return { user: user.id, tenant: world.tenant.id };
}

it('没有 update 按钮：改名选是首发 403、同键重放 403，任职不变；改上级选否与 employment-preview 同样 403', async () => {
  const w = await activationWorld(database().db, 'org35nobtn');
  const person = await w.hired();
  const world = await permissionWorld(w);
  const as = await actor(world, [w.from.id, w.to.id], []);
  const body = { name: '改名无按钮', effectiveDate: '2026-10-01', addEmployment: true };
  const key = randomUUID();
  const rename = () =>
    world.api.request('PATCH', `${ORG}/${w.from.id}`, { ...as, ifMatch: w.from.revision, idempotencyKey: key, body });
  expect((await rename()).status).toBe(403);
  expect((await rename()).status).toBe(403);
  expect(await w.session.records(person.employee.id)).toHaveLength(1);
  const preview = await world.api.request('POST', `${ORG}/${w.from.id}/employment-preview`, { ...as, body });
  expect(preview.status).toBe(403);
  const reparent = await world.api.request('PATCH', `${ORG}/${w.from.id}`, {
    ...as,
    ifMatch: w.from.revision,
    body: { parents: { admin: { parentId: w.to.id } }, effectiveDate: '2026-10-01', addEmployment: false },
  });
  expect(reparent.status).toBe(403);
  expect(await w.session.records(person.employee.id)).toHaveLength(1);
});

it('有 update 按钮：同一请求 200 并追加组织调整，同键重放返回同一结果；employment-preview 200', async () => {
  const w = await activationWorld(database().db, 'org35btn');
  const person = await w.hired();
  const world = await permissionWorld(w);
  const as = await actor(world, [w.from.id, w.to.id], [UPDATE_BUTTON]);
  const body = { name: '改名有按钮', effectiveDate: '2026-10-01', addEmployment: true };
  const preview = await world.api.request('POST', `${ORG}/${w.from.id}/employment-preview`, { ...as, body });
  expect(preview.status, await preview.clone().text()).toBe(200);
  expect(await preview.json()).toEqual({ hasPendingEmployment: false });
  const key = randomUUID();
  const rename = () =>
    world.api.request('PATCH', `${ORG}/${w.from.id}`, { ...as, ifMatch: w.from.revision, idempotencyKey: key, body });
  const first = await rename();
  expect(first.status, await first.clone().text()).toBe(200);
  const records = await w.session.records(person.employee.id);
  expect(records.map((record) => record.kind)).toEqual(['hire', 'org_adjustment']);
  const replay = await rename();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(await first.json());
  expect(await w.session.records(person.employee.id)).toHaveLength(2);
});
