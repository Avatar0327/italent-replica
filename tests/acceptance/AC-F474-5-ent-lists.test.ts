/**
 * F-474-5 #21～23（R1bd §2.8～2.10，转03）：用户 / 用户授权 / 管理员三张列表补投影列、筛选、分页与总数。
 * 只读，不新增写入口、不新增权限操作；总数与当页同一过滤口径；租户隔离；入口能力不变。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
type Json = Record<string, unknown>;

describe('F-474-5 #21～23 企业设置列表投影', () => {
  let world: PermissionWorld;
  const tag = uniqueSuffix();
  let profileA: ProfileBody;
  let profileB: ProfileBody;
  let mouId: string;
  let alice: { id: string; email: string };
  let bob: { id: string; email: string };

  const get = async (path: string, as = world.asAdmin) => {
    const response = await world.api.request('GET', `${BASE}${path}`, as);
    return { status: response.status, body: (await response.json()) as Json & { items: Json[]; total: number } };
  };

  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    const a = await addMember(world, `alice-${tag}`);
    const b = await addMember(world, `bob-${tag}`);
    alice = { id: a.id, email: a.email! };
    bob = { id: b.id, email: b.email! };
    profileA = await createProfile(world, `PA-${tag}`);
    profileB = await createProfile(world, `PB-${tag}`);
    await makeGrantable(world, [profileA.id, profileB.id]);
    const mou = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `M-${tag}`, name: `管理单元-${tag}`, orgRanges: [] },
    });
    mouId = ((await mou.json()) as { id: string }).id;
    const scope = await world.api.request('PUT', `${BASE}/scopes/${alice.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
    expect((await grant(world, alice.id, profileA.id)).status).toBe(201);
    expect((await grant(world, bob.id, profileA.id)).status).toBe(201);
    expect((await grant(world, bob.id, profileB.id)).status).toBe(201);
  });

  describe('#21 用户列表', () => {
    it('返回总数（与当页同一过滤口径）与创建时间，分页不重不漏', async () => {
      const all = await get('/users?limit=200');
      expect(all.body.total).toBe(all.body.items.length);
      expect(all.body.items.every((item) => typeof item.createdAt === 'string')).toBe(true);
      const first = await get('/users?limit=2&offset=0');
      const second = await get('/users?limit=2&offset=2');
      expect(first.body.total).toBe(all.body.total);
      expect(first.body.items).toHaveLength(2);
      const ids = [...first.body.items, ...second.body.items].map((item) => item.userId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('按姓名 / 登录邮箱筛选：总数只算命中行；不命中为 0；通配符按字面处理', async () => {
      const byName = await get(`/users?${new URLSearchParams({ q: `alice-${tag}` })}`);
      expect(byName.body.items.map((item) => item.userId)).toEqual([alice.id]);
      expect(byName.body.total).toBe(1);
      const byEmail = await get(`/users?${new URLSearchParams({ q: bob.email.toUpperCase() })}`);
      expect(byEmail.body.items.map((item) => item.userId)).toEqual([bob.id]);
      expect((await get(`/users?${new URLSearchParams({ q: 'zzz-none' })}`)).body.total).toBe(0);
      expect((await get(`/users?${new URLSearchParams({ q: '%' })}`)).body.total).toBe(0);
    });

    it('成员状态筛选；非法参数 400；无用户管理能力 403', async () => {
      const active = await get('/users?membershipStatus=active&limit=200');
      expect(active.body.items.every((item) => item.membershipStatus === 'active')).toBe(true);
      expect((await get('/users?membershipStatus=bogus')).status).toBe(400);
      const plain = await addMember(world, 'f474-5-plain');
      expect((await get('/users', { user: plain.id, tenant: world.tenant.id })).status).toBe(403);
    });

    it('另一租户的用户不会命中', async () => {
      const other = await seedPermissionWorld(world.db);
      const foreign = await addMember(other, `alice-${tag}-foreign`);
      const result = await get(`/users?${new URLSearchParams({ q: foreign.email! })}`);
      expect(result.body.total).toBe(0);
    });
  });

  describe('#22 用户授权列表', () => {
    it('不带 userId 也可列出全租户授权，带姓名 / 邮箱 / 身份 / 产品 / 管理单元 / 授权人', async () => {
      const result = await get('/grants?limit=200');
      expect(result.status).toBe(200);
      const row = result.body.items.find((item) => item.userId === alice.id)!;
      expect(row).toMatchObject({
        userEmail: alice.email,
        profileCode: `PA-${tag}`,
        profileName: `身份PA-${tag}`,
        apps: ['TenantBase'],
        status: 'active',
        mous: [{ appCode: 'TenantBase', mouId, name: `管理单元-${tag}` }],
        grantedBy: { userId: world.admin.id },
      });
      expect(typeof row.createdAt).toBe('string');
      const bobRow = result.body.items.find((item) => item.userId === bob.id && item.profileId === profileB.id)!;
      expect(bobRow.mous).toEqual([]);
      expect(result.body.total).toBe(result.body.items.length);
    });

    it('按姓名 / 邮箱 / 身份 / 管理单元筛选，总数同口径，分页稳定', async () => {
      const byUser = await get(`/grants?${new URLSearchParams({ q: `bob-${tag}` })}`);
      expect(byUser.body.items.map((item) => item.profileId).sort()).toEqual([profileA.id, profileB.id].sort());
      expect(byUser.body.total).toBe(2);
      const byProfile = await get(`/grants?profileId=${profileB.id}`);
      expect(byProfile.body.items.map((item) => item.userId)).toEqual([bob.id]);
      const byMou = await get(`/grants?mouId=${mouId}`);
      expect(byMou.body.items.map((item) => item.userId)).toEqual([alice.id]);
      expect(byMou.body.total).toBe(1);
      const p1 = await get(`/grants?${new URLSearchParams({ q: `bob-${tag}`, limit: '1', offset: '0' })}`);
      const p2 = await get(`/grants?${new URLSearchParams({ q: `bob-${tag}`, limit: '1', offset: '1' })}`);
      expect(p1.body.total).toBe(2);
      expect(new Set([p1.body.items[0]!.id, p2.body.items[0]!.id]).size).toBe(2);
    });

    it('撤销身份后授权行仍可见为已撤销，用户的管理单元不被连带删除（DEC-043）', async () => {
      const row = (await get(`/grants?profileId=${profileA.id}&userId=${alice.id}`)).body.items[0]!;
      const revoked = await world.api.request('POST', `${BASE}/grants/${row.id}/revoke`, {
        ...world.asAdmin,
        ifMatch: row.revision as number,
      });
      expect(revoked.status, await revoked.clone().text()).toBe(200);
      const after = (await get(`/grants?userId=${alice.id}`)).body.items[0]!;
      expect(after).toMatchObject({ status: 'revoked', mous: [{ mouId }] });
      expect((await get(`/grants?status=active&userId=${alice.id}`)).body.items).toEqual([]);
    });

    it('参数不合法 400；无用户授权能力 403；另一租户的授权不出现', async () => {
      expect((await get('/grants?profileId=not-a-uuid')).status).toBe(400);
      expect((await get('/grants?limit=0')).status).toBe(400);
      const plain = await addMember(world, 'f474-5-plain2');
      expect((await get('/grants', { user: plain.id, tenant: world.tenant.id })).status).toBe(403);
      const other = await seedPermissionWorld(world.db);
      const foreign = await addMember(other, 'foreign-grantee');
      const foreignProfile = await createProfile(other, `PF-${tag}`);
      await makeGrantable(other, [foreignProfile.id]);
      expect((await grant(other, foreign.id, foreignProfile.id)).status).toBe(201);
      const mine = await get('/grants?limit=200');
      expect(mine.body.items.some((item) => item.userId === foreign.id)).toBe(false);
    });
  });

  describe('#23 管理员列表', () => {
    it('带姓名 / 邮箱 / 创建时间 / 创建人 / 管理单元，并有总数', async () => {
      const auditor = await memberWithAdminRole(world, 'audit_admin', `auditor-${tag}`);
      const result = await get('/admins?limit=200');
      expect(result.status).toBe(200);
      const row = result.body.items.find((item) => item.userId === auditor.user.id)!;
      expect(row).toMatchObject({
        role: 'audit_admin',
        displayName: `auditor-${tag}`,
        email: auditor.user.email,
        createdBy: { userId: world.admin.id },
        mous: [],
      });
      expect(typeof row.createdAt).toBe('string');
      expect(result.body.total).toBe(result.body.items.length);
    });

    it('按姓名 / 邮箱 / 管理员身份 / 管理单元筛选，分页同口径', async () => {
      const byName = await get(`/admins?${new URLSearchParams({ q: `auditor-${tag}` })}`);
      expect(byName.body.total).toBe(1);
      expect((await get('/admins?role=audit_admin&limit=1')).body.items).toHaveLength(1);
      const roles = await get('/admins?role=tenant_admin');
      expect(roles.body.items.every((item) => item.role === 'tenant_admin')).toBe(true);
      expect((await get('/admins?role=bogus')).status).toBe(400);
      const owner = await memberWithAdminRole(world, 'user_admin', `owner-${tag}`);
      await world.api.request('PUT', `${BASE}/scopes/${owner.user.id}/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'mou', mouId },
      });
      const byMou = await get(`/admins?mouId=${mouId}`);
      expect(byMou.body.items.map((item) => item.userId)).toEqual([owner.user.id]);
      expect(byMou.body.total).toBe(1);
    });

    it('无管理员管理能力 403；另一租户管理员不出现', async () => {
      const plain = await addMember(world, 'f474-5-plain3');
      expect((await get('/admins', { user: plain.id, tenant: world.tenant.id })).status).toBe(403);
      const other = await seedPermissionWorld(world.db);
      const mine = await get('/admins?limit=200');
      expect(mine.body.items.some((item) => item.userId === other.admin.id)).toBe(false);
    });
  });
});
