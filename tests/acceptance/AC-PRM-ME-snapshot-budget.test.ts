/**
 * 权限快照整包体积预算（DEC-469 第 2 轮）：多个应用的数据范围都很大时，整个响应仍须 ≤ 32,768 字节（UTF-8），
 * 被省略或截短的应用 truncated=true（status 仍为 limited），没被截的应用完整返回。
 */
import '@italent/api'; // 各模块在加载时登记自己的对象
import { randomUUID } from 'node:crypto';
import { APP_IDS, APP_OBJECT_DIRECTORY } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const LIMIT = 32 * 1024;
/** 有数据范围、且对象属于 11 个入口应用（TenantBase 下 4 个 + 7 个独立应用）。 */
const SCOPED = APP_IDS.filter((app) => !['approval', 'self', 'settings', 'manager'].includes(app));

interface Snapshot {
  apps: { app: string; visible: boolean; entryObjects: string[] }[];
  scope: { app: string; status: string; organizationIds: string[]; truncated: boolean }[];
  adminMenus: unknown[];
}

describe('权限快照整包体积预算', () => {
  it('11 个应用都配到同一个 200 组织的管理单元：响应 ≤ 32,768 字节，被截的 truncated=true，小范围应用完整', async () => {
    const world = await seedPermissionWorld(database().db);
    const setup = tenantApi(world.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const org = async (name: string, parentId: string) => {
      const response = await setup.request('POST', '/api/tenant/org/organizations', {
        ...world.asAdmin,
        ifMatch: 0,
        body: { name, parents: { admin: { parentId } } },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const root = await org('预算根组织', world.tenant.id);
    const all = [root];
    for (let i = 1; i < 200; i++) all.push(await org(`预算组织${i}`, root));
    const mou = async (orgs: { orgId: string; includeDescendants: boolean }[]) => {
      const response = await world.api.request('POST', `${BASE}/mous`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { code: randomUUID(), name: '预算管理单元', orgRanges: orgs },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const big = await mou([{ orgId: root, includeDescendants: true }]);
    const small = await mou(all.slice(0, 3).map((orgId) => ({ orgId, includeDescendants: false })));

    // 每个应用取第一个对象授查看；一个身份覆盖全部所属应用
    const first = new Map(
      SCOPED.map((app) => [app, APP_OBJECT_DIRECTORY[app].find((code) => objectCatalog.get(code))!]),
    );
    const permissionApps = [...new Set([...first.values()].map((code) => objectCatalog.get(code)!.application))];
    const profile = await createProfile(world, `budget-${uniqueSuffix()}`, { apps: permissionApps });
    for (const code of new Set(first.values())) {
      const response = await setObjectPermission(
        world,
        profile,
        { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [] },
        code,
      );
      expect(response.status, `${code} ${await response.clone().text()}`).toBe(200);
    }
    await makeGrantable(world, [profile.id]);
    const member = await addMember(world, 'budget');
    expect((await grant(world, member.id, profile.id)).status).toBe(201);
    const who = { user: member.id, tenant: world.tenant.id };
    // idp 用小范围（3 个组织），其余应用都用大范围
    const smallApp = objectCatalog.get(first.get('idp')!)!.application;
    for (const application of permissionApps) {
      const response = await world.api.request('PUT', `${BASE}/scopes/${member.id}/${application}`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'mou', mouId: application === smallApp ? small : big },
      });
      expect(response.status, `${application} ${await response.clone().text()}`).toBe(200);
    }

    const response = await world.api.request('GET', `${BASE}/me/snapshot`, who);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(LIMIT);
    const body = JSON.parse(text) as Snapshot;
    expect(body.apps.filter((a) => SCOPED.includes(a.app as never) && a.visible)).toHaveLength(SCOPED.length);
    const scopes = body.scope.filter((s) => SCOPED.includes(s.app as never));
    expect(scopes).toHaveLength(SCOPED.length);
    for (const item of scopes) {
      expect(item.status, item.app).toBe('limited');
      const expected = item.app === 'idp' ? 3 : 200;
      if (item.organizationIds.length < expected)
        expect(item.truncated, `${item.app} 被截短必须置 truncated`).toBe(true);
      else expect(item.truncated, `${item.app} 完整不应置 truncated`).toBe(false);
      expect(new Set(item.organizationIds).size, item.app).toBe(item.organizationIds.length);
      for (const id of item.organizationIds) expect(all, item.app).toContain(id);
    }
    expect(scopes.find((s) => s.app === 'idp')).toMatchObject({ truncated: false });
    expect(scopes.find((s) => s.app === 'idp')!.organizationIds).toHaveLength(3);
    const big200 = scopes.filter((s) => s.app !== 'idp');
    expect(big200.some((s) => s.truncated)).toBe(true);
    // 预算按 round-robin 公平分配：任意两个被截应用的条数相差不超过 1
    const counts = big200.map((s) => s.organizationIds.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  }, 600_000);
});
