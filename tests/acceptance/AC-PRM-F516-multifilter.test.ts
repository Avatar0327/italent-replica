import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
let world: PermissionWorld;
const profiles: string[] = [];
const mous: string[] = [];
const users: string[] = [];
const get = async (path: string) => {
  const response = await world.api.request('GET', `${BASE}${path}`, world.asAdmin);
  return { status: response.status, body: (await response.json()) as { items: { userId: string }[]; total: number } };
};
beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
  const tag = uniqueSuffix();
  for (let index = 0; index < 3; index++) {
    profiles.push((await createProfile(world, `F516-${tag}-${index}`)).id);
    const actor = await memberWithAdminRole(world, 'audit_admin', `F516-${tag}-${index}`);
    users.push(actor.user.id);
    const response = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `F516-${tag}-${index}`, name: `单元${index}`, orgRanges: [] },
    });
    expect(response.status).toBe(201);
    mous.push(((await response.json()) as { id: string }).id);
    expect(
      (
        await world.api.request('PUT', `${BASE}/scopes/${actor.user.id}/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { kind: 'mou', mouId: mous[index] },
        })
      ).status,
    ).toBe(200);
  }
  await makeGrantable(world, profiles);
  for (let index = 0; index < 3; index++)
    expect((await grant(world, users[index]!, profiles[index]!)).status).toBe(201);
});

const repeated = (key: string, values: string[]) => new URLSearchParams(values.map((value) => [key, value])).toString();
describe('AC-PRM-F516 列表多值条件', () => {
  it('身份任一匹配，大小写 UUID 与单值兼容，跨条件取交集', async () => {
    const query = repeated('profileId', [profiles[0]!.toUpperCase(), profiles[1]!]);
    const result = await get(`/grants?${query}`);
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(2);
    expect(result.body.items.map((row) => row.userId).sort()).toEqual(users.slice(0, 2).sort());
    expect((await get(`/grants?profileId=${profiles[1]}`)).body.total).toBe(1);
    expect((await get(`/grants?${query}&mouId=${mous[1]}`)).body.items.map((row) => row.userId)).toEqual([users[1]]);
    expect((await get(`/grants?${query}&mouId=${mous[2]}`)).body).toMatchObject({ items: [], total: 0 });
  });
  it.each(['/grants', '/admins'])('%s 管理单元任一匹配，total 与分页使用同一条件', async (path) => {
    const query = repeated('mouId', mous.slice(0, 2));
    const first = await get(`${path}?${query}&limit=1`);
    const second = await get(`${path}?${query}&limit=1&offset=1`);
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(2);
    expect(second.body.total).toBe(2);
    expect([...first.body.items, ...second.body.items].map((row) => row.userId).sort()).toEqual(
      users.slice(0, 2).sort(),
    );
    expect((await get(`${path}?mouId=${mous[0]}`)).body.total).toBe(1);
    expect((await get(`${path}?${repeated('mouId', [mous[0]!, mous[0]!])}`)).body.total).toBe(1);
  });
  it('拒绝后续值非法的条件，不能静默忽略', async () => {
    expect((await get(`/grants?profileId=${profiles[0]}&profileId=bad`)).status).toBe(400);
    for (const path of ['/grants', '/admins'])
      expect((await get(`${path}?mouId=${mous[0]}&mouId=bad`)).status).toBe(400);
  });
});
