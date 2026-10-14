import { resolve } from 'node:path';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { fieldAccess, type ObjectPermission } from '../../apps/web/src/foundation/permission-model.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const today = '2026-10-13';
const future = '2026-10-20';
const model = () => import(resolve('apps/web/src/job/page-model.ts'));

async function prepare(editDate: boolean) {
  const world = await seedPermissionWorld(testDb().db);
  // UTC 12 日仍对应上海 13 日；只读日期使用接口返回的租户当天。
  const api = tenantApi(world.db, { authorize: undefined, clock: () => new Date('2026-10-12T17:00:00Z') });
  const setup = tenantApi(world.db, { clock: () => new Date('2026-10-12T17:00:00Z') });
  const member = await addMember(world, 'date-create');
  const actor = { user: member.id, tenant: world.tenant.id };
  const create = async (path: string, body: object) => {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...actor, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const org = await create('org/organizations', {
    name: '日期回归组织',
    parents: { admin: { parentId: world.tenant.id } },
  });
  const post = await create('job/posts', { name: '当天职务', startDate: today });
  const futurePost = await create('job/posts', { name: '未来职务', startDate: future });
  const profile = await createProfile(world, 'date-create');
  const { jobObjects } = await model();
  for (const code of Object.values(jobObjects)) {
    const definition = Object.values(MODULE_OBJECTS).find((object) => object.code === code)!;
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: false, delete: false },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: true,
          edit: !field.system && (field.code !== 'startDate' || editDate),
        })),
        buttons: [{ buttonCode: 'create', level: 'list' }],
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    const scope = await world.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
      {
        ...world.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: definition.code, seeAll: true },
      },
    );
    expect(scope.status).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, member.id, profile.id)).status).toBe(201);
  const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${member.id}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: org.id, includeDescendants: false }] },
  });
  expect(scope.status).toBe(200);
  return { api, world, org, post, futurePost, actor: { user: member.id, tenant: world.tenant.id } };
}

for (const editDate of [true, false]) {
  it(`AC-FE-R1a-20 真实权限与落库：8 类新建日期${editDate ? '可编辑取未来' : '只读取租户当天'}`, async () => {
    const { jobTiming, jobBody, jobKinds, jobObjects } = await model();
    const s = await prepare(editDate);
    for (const kind of jobKinds) {
      const permissionResponse = await s.api.request(
        'GET',
        `/api/tenant/permission/me/objects/${jobObjects[kind]}`,
        s.actor,
      );
      expect(permissionResponse.status).toBe(200);
      const permission = (await permissionResponse.json()) as ObjectPermission;
      const list = await s.api.request('GET', `/api/tenant/job/${kind}?asOf=${future}`, s.actor);
      expect(list.status).toBe(200);
      const tenantToday = ((await list.json()) as { today: string }).today;
      expect(tenantToday).toBe(today);
      const timing = jobTiming(undefined, future, tenantToday, fieldAccess(permission, 'startDate'));
      const expectedDate = editDate ? future : today;
      expect(timing.asOf).toBe(expectedDate);
      const postId = editDate ? s.futurePost.id : s.post.id;
      const values = { name: `日期回归${kind}`, ...(kind === 'positions' ? { orgId: s.org.id, postId } : {}) };
      if (kind === 'positions') {
        const candidates = await s.api.request('GET', `/api/tenant/job/posts?asOf=${timing.asOf}`, s.actor);
        expect(candidates.status, await candidates.clone().text()).toBe(200);
        const ids = ((await candidates.json()) as { items: { id: string }[] }).items.map((item) => item.id);
        expect(ids).toContain(postId);
        if (!editDate) expect(ids).not.toContain(s.futurePost.id);
      }
      const body = jobBody(kind, { ...values, ...timing.createFields }, undefined, timing.asOf);
      if (!editDate) expect(body).not.toHaveProperty('startDate');
      const response = await s.api.request('POST', `/api/tenant/job/${kind}`, { ...s.actor, ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(201);
      const saved = (await response.json()) as { id: string; startDate: string };
      expect(saved.startDate).toBe(expectedDate);
      const detail = await s.api.request('GET', `/api/tenant/job/${kind}/${saved.id}?asOf=${expectedDate}`, s.actor);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ ...values, startDate: expectedDate });
    }
  });
}
