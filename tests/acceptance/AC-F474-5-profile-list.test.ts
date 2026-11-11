/**
 * F-474-5 #25（R1bd §2.12，DEC-778③）：身份管理列表补「最近修改人 / 修改时间 / 授权范围」、筛选与分页。
 * 最近修改人 = profiles.updatedBy：新建与保存对象权限时写入；迁移前的旧行没有（DEC-402：不回填、不开关，返回空）。
 * 来源视图不展示（DEC-340③）；身份没有停用概念，状态列不伪造。
 */
import { eq, permissionProfiles, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  DEMO_OBJECT,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
type Json = Record<string, unknown>;

describe('F-474-5 #25 身份管理列表', () => {
  let world: PermissionWorld;
  let second: Awaited<ReturnType<typeof memberWithAdminRole>>;
  const tag = uniqueSuffix();
  let alpha: ProfileBody;
  let beta: ProfileBody;
  let legacy: ProfileBody;

  const list = async (query = '', as = world.asAdmin) => {
    const response = await world.api.request('GET', `${BASE}/profiles${query}`, as);
    return { status: response.status, body: (await response.json()) as { items: Json[]; total: number } & Json };
  };
  const row = async (id: string) => (await list('?limit=500')).body.items.find((item) => item.id === id)!;

  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    second = await memberWithAdminRole(world, 'system_admin', `sysadmin-${tag}`);
    alpha = await createProfile(world, `ALPHA-${tag}`);
    beta = await createProfile(world, `BETA-${tag}`, { apps: ['DemoPayroll'] });
    legacy = await createProfile(world, `LEGACY-${tag}`);
    // 迁移前的旧行：没有修改人
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.update(permissionProfiles).set({ updatedBy: null }).where(eq(permissionProfiles.id, legacy.id)),
    );
    await makeGrantable(world, [alpha.id]);
    const member = await addMember(world, `holder-${tag}`);
    expect((await grant(world, member.id, alpha.id)).status).toBe(201);
  });

  it('新建身份记录最近修改人；旧行（无修改人）返回空，不回填', async () => {
    expect(await row(alpha.id)).toMatchObject({
      updatedBy: { userId: world.admin.id },
      updatedAt: expect.any(String),
    });
    expect((await row(legacy.id)).updatedBy).toBeNull();
  });

  it('保存对象权限后，最近修改人变为保存人；改的是别的身份时不影响本行', async () => {
    const response = await world.api.request('PUT', `${BASE}/profiles/${alpha.id}/objects/${DEMO_OBJECT.code}`, {
      user: second.user.id,
      tenant: world.tenant.id,
      ifMatch: alpha.revision,
      body: { dataOperations: { create: true, update: false, delete: false }, fields: [], buttons: [] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await row(alpha.id);
    expect(after.updatedBy).toMatchObject({ userId: second.user.id, displayName: `sysadmin-${tag}` });
    expect((await row(beta.id)).updatedBy).toMatchObject({ userId: world.admin.id });
  });

  it('授权范围投影：有效授权数；没有来源视图列，也不伪造状态列', async () => {
    const item = await row(alpha.id);
    expect(item.grantCount).toBe(1);
    expect((await row(beta.id)).grantCount).toBe(0);
    expect(item).not.toHaveProperty('sourceView');
    expect(item).not.toHaveProperty('status');
    expect((await list()).body.unrecorded).toEqual(expect.arrayContaining(['status', 'sourceView']));
  });

  it('按名称 / 编码 / 关联应用筛选，总数与当页同口径，分页稳定', async () => {
    const byCode = await list(`?${new URLSearchParams({ code: `alpha-${tag}` })}`);
    expect(byCode.body.items.map((item) => item.id)).toEqual([alpha.id]);
    expect(byCode.body.total).toBe(1);
    const byName = await list(`?${new URLSearchParams({ name: `身份BETA-${tag}` })}`);
    expect(byName.body.items.map((item) => item.id)).toEqual([beta.id]);
    const byApp = await list('?app=DemoPayroll&limit=500');
    expect(byApp.body.items.map((item) => item.id)).toContain(beta.id);
    expect(byApp.body.items.every((item) => (item.apps as string[]).includes('DemoPayroll'))).toBe(true);
    expect(byApp.body.total).toBe(byApp.body.items.length);
    expect((await list(`?${new URLSearchParams({ code: '%' })}`)).body.total).toBe(0);
    const all = await list('?limit=500');
    expect(all.body.total).toBe(all.body.items.length);
    const p1 = await list('?limit=2&offset=0');
    const p2 = await list('?limit=2&offset=2');
    expect(p1.body.total).toBe(all.body.total);
    const ids = [...p1.body.items, ...p2.body.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('参数不合法 400；无身份管理能力 403；另一租户的身份不出现', async () => {
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?app=bad app')).status).toBe(400);
    const plain = await addMember(world, 'f474-5-plain4');
    expect((await list('', { user: plain.id, tenant: world.tenant.id })).status).toBe(403);
    const other = await seedPermissionWorld(world.db);
    const foreign = await createProfile(other, `FOREIGN-${tag}`);
    const mine = await list('?limit=500');
    expect(mine.body.items.some((item) => item.id === foreign.id)).toBe(false);
  });

  it('再次保存后，最近修改人以最后一次成功保存的人为准', async () => {
    const fresh = (await row(alpha.id)) as { revision: number };
    const response = await setObjectPermission(
      world,
      { ...alpha, revision: fresh.revision },
      { dataOperations: { create: true, update: false, delete: false }, fields: [], buttons: [] },
    );
    expect(response.status).toBe(200);
    expect((await row(alpha.id)).updatedBy).toMatchObject({ userId: world.admin.id });
  });
});
