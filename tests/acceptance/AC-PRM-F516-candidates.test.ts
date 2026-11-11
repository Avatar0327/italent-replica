import { permissionMous, permissionProfiles, permissionAdmins, withTenant, eq } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, createProfile, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

let handle: Awaited<ReturnType<typeof createTestDb>>;
// 本机多工作树并行时完整迁移可能超过 60 秒，与 F-039 重型建库钩子使用同一等待预算。
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => {
  await handle?.close();
});
const database = () => handle;
const paths = ['/grants/profile-candidates', '/grants/mou-candidates', '/admins/mou-candidates'];
let world: PermissionWorld;
let reader: { user: string; tenant: string };
const profiles: string[] = [];
const mous: string[] = [];
const tag = `F516-${uniqueSuffix()}`;
const get = async (path: string, as = reader) => {
  const response = await world.api.request('GET', `${BASE}${path}`, as);
  return {
    status: response.status,
    body: (await response.json()) as { items: { id: string; name: string }[]; total: number },
  };
};

beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
  const actor = await memberWithAdminRole(world, 'user_admin', '候选读者');
  reader = { user: actor.user.id, tenant: world.tenant.id };
  for (let index = 0; index < 3; index++) {
    profiles.push((await createProfile(world, `${tag}-${index}`)).id);
    const response = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `${tag}-${index}`, name: `${tag}-单元${index}`, orgRanges: [] },
    });
    expect(response.status).toBe(201);
    mous.push(((await response.json()) as { id: string }).id);
  }
  await withTenant(world.db, world.tenant.id, async (tx) => {
    await tx.update(permissionMous).set({ status: 'disabled' }).where(eq(permissionMous.id, mous[1]!));
    await tx.update(permissionMous).set({ status: 'deleted' }).where(eq(permissionMous.id, mous[2]!));
  });
});

describe('AC-PRM-F516 独立筛选候选', () => {
  it('身份候选包含未授权身份，独立于列表当页与可授权集合', async () => {
    expect((await get('/grantable-profiles')).body.items).toEqual([]);
    expect((await get('/grants')).body.items).toEqual([]);
    const result = await get(`/grants/profile-candidates?q=${tag}&limit=200`);
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(3);
    expect(result.body.items.map((item) => item.id)).toEqual(profiles);
    expect(result.body.items[0]).toEqual({ id: profiles[0], name: `身份${tag}-0` });
  });

  it.each(paths)('%s 名称搜索、稳定分页与空集', async (path) => {
    const first = await get(`${path}?q=${tag.toUpperCase()}&limit=1&offset=0`);
    const second = await get(`${path}?q=${tag}&limit=1&offset=1`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.total).toBe(path.includes('profile') ? 3 : 2);
    expect(second.body.total).toBe(first.body.total);
    expect(first.body.items).toHaveLength(1);
    expect(second.body.items).toHaveLength(1);
    expect(first.body.items[0]!.id).not.toBe(second.body.items[0]!.id);
    expect((await get(`${path}?q=${tag}&offset=200`)).body.items).toEqual([]);
    expect((await get(`${path}?q=%25`)).body).toEqual({ items: [], total: 0 });
    expect((await get(`${path}?q=不存在的候选`)).body).toEqual({ items: [], total: 0 });
  });

  it.each(['/grants/mou-candidates', '/admins/mou-candidates'])('%s 包含停用但排除删除管理单元', async (path) => {
    const result = await get(`${path}?q=${tag}`);
    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([
      { id: mous[0], name: `${tag}-单元0` },
      { id: mous[1], name: `${tag}-单元1` },
    ]);
  });

  it.each(paths)('%s 按当前能力、租户裁剪，校验分页边界', async (path) => {
    const plain = await memberWithAdminRole(world, 'audit_admin', `无候选权-${uniqueSuffix()}`);
    expect((await get(path, { user: plain.user.id, tenant: world.tenant.id })).status).toBe(403);
    const other = await seedPermissionWorld(world.db);
    expect((await get(`${path}?q=${tag}`, other.asAdmin)).body).toEqual({ items: [], total: 0 });
    expect((await get(`${path}?limit=201`)).status).toBe(400);
    expect((await get(`${path}?offset=-1`)).status).toBe(400);
  });
  it('超过单页上限的目录可以翻页穷尽，通配符按字面匹配，虚拟单元不可见', async () => {
    const prefix = `F516-scale-${uniqueSuffix()}`;
    await withTenant(world.db, world.tenant.id, async (tx) => {
      const values = Array.from({ length: 205 }, (_, index) => ({
        tenantId: world.tenant.id,
        code: `${prefix}-${index.toString().padStart(3, '0')}`,
        name: `${prefix}-${index}`,
      }));
      await tx.insert(permissionProfiles).values(values);
      await tx.insert(permissionMous).values(values);
      await tx.insert(permissionMous).values({
        tenantId: world.tenant.id,
        code: `${prefix}-virtual`,
        name: `${prefix}-虚拟`,
        kind: 'virtual',
        ownerUserId: reader.user,
        appCode: 'TenantBase',
      });
      await tx
        .insert(permissionProfiles)
        .values({ tenantId: world.tenant.id, code: `${prefix}-literal`, name: '字面%_\\' });
    });
    for (const path of paths) {
      const first = (await get(`${path}?q=${prefix}&limit=200`)).body;
      const last = (await get(`${path}?q=${prefix}&limit=200&offset=200`)).body;
      expect(first.items).toHaveLength(200);
      expect(last.items).toHaveLength(5);
      expect(first.total).toBe(205);
      expect(last.total).toBe(205);
      expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(205);
    }
    const literal = await get(`/grants/profile-candidates?${new URLSearchParams({ q: '%_\\' })}`);
    expect(literal.body.total).toBe(1);
    expect(literal.body.items[0]!.name).toBe('字面%_\\');
  });
  it('撤销管理员能力后候选请求立即拒绝', async () => {
    const actor = await memberWithAdminRole(world, 'user_admin', `撤权-${uniqueSuffix()}`);
    const as = { user: actor.user.id, tenant: world.tenant.id };
    for (const path of paths) expect((await get(path, as)).status).toBe(200);
    await withTenant(world.db, world.tenant.id, async (tx) => {
      await tx.update(permissionAdmins).set({ status: 'revoked' }).where(eq(permissionAdmins.userId, actor.user.id));
    });
    for (const path of paths) expect((await get(path, as)).status).toBe(403);
  });
});
