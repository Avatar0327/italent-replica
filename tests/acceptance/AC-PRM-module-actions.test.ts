/**
 * R1-T01 接入已上线模块（R1-T03 组织、R1-T04 职务 / 编制、R1-T05 任职）：真实授权器下，
 * 模块路由动作 tenant.<模块>.read|write 按身份对象权限判定——
 * 持有“含对应对象、且登记了组织员工应用（TenantBase）”身份的用户可访问；无身份一律 403（fail-closed 不变）。
 * 模块配置类动作（任职设置、自定义字段）按租户配置收口，只给租户管理员（需取证 #7）。
 * 写接口带不合法请求体：通过鉴权即得到 400 VALIDATION_FAILED，被拒为 403；业务结果由各模块自己的验收测试覆盖。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();

const MODULES = [
  { name: '组织', object: MODULE_OBJECTS.organization.code, settings: '/api/tenant/org/settings' },
  { name: '职务', object: MODULE_OBJECTS.jobPost.code, settings: '/api/tenant/job/settings' },
  { name: '编制', object: MODULE_OBJECTS.establishment.code, settings: '/api/tenant/establishment/settings' },
  { name: '任职', object: MODULE_OBJECTS.employmentRecord.code, settings: '/api/tenant/employment/employees' },
] as const;

/** 写接口：带一个必然不合法的请求体——通过鉴权后得到 400，被拒则为 403。 */
const WRITES = {
  组织: { method: 'PUT', path: '/api/tenant/org/settings' },
  职务: { method: 'PUT', path: '/api/tenant/job/settings' },
  编制: { method: 'PUT', path: '/api/tenant/establishment/settings' },
  任职: { method: 'POST', path: '/api/tenant/employment/employees' },
} as const;

describe('已上线模块的路由动作接入真实授权器', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  async function profileFor(code: string, objectCode: string, update: boolean, apps = ['TenantBase']) {
    const profile: ProfileBody = await createProfile(world, code, { apps });
    const res = await setObjectPermission(
      world,
      profile,
      { dataOperations: { create: false, update, delete: false }, fields: [], buttons: [] },
      objectCode,
    );
    if (res.status !== 200) throw new Error(`配置身份失败：${res.status} ${await res.text()}`);
    await makeGrantable(world, [profile.id]);
    return profile;
  }

  for (const module of MODULES) {
    it(`${module.name}：无身份 403；只读身份可读不可写；可编辑身份可写`, async () => {
      const as = (userId: string) => ({ user: userId, tenant: world.tenant.id });
      const write = WRITES[module.name];
      const tag = module.object.split('.')[1]!.toLowerCase();

      const nobody = await addMember(world, `${tag}-nobody`);
      expect((await world.api.request('GET', module.settings, as(nobody.id))).status).toBe(403);
      expect(
        (await world.api.request(write.method, write.path, { ...as(nobody.id), ifMatch: 0, body: {} })).status,
      ).toBe(403);
      // 租户管理员只有企业设置能力，没有业务身份 → 同样 403（不存在“管理员看全部”）
      expect((await world.api.request('GET', module.settings, world.asAdmin)).status).toBe(403);

      const viewer = await addMember(world, `${tag}-viewer`);
      await grant(world, viewer.id, (await profileFor(`${tag}-view`, module.object, false)).id);
      expect((await world.api.request('GET', module.settings, as(viewer.id))).status).toBe(200);
      expect(
        (await world.api.request(write.method, write.path, { ...as(viewer.id), ifMatch: 0, body: {} })).status,
      ).toBe(403);

      const editor = await addMember(world, `${tag}-editor`);
      await grant(world, editor.id, (await profileFor(`${tag}-edit`, module.object, true)).id);
      const res = await world.api.request(write.method, write.path, { ...as(editor.id), ifMatch: 0, body: {} });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION_FAILED');
    });
  }

  it('身份未登记组织员工应用时，即便库里有该对象也不放行（应用边界）', async () => {
    const outsider = await addMember(world, 'outsider');
    const profile = await createProfile(world, 'outsider-profile', { apps: ['OtherApp'] });
    const denied = await setObjectPermission(
      world,
      profile,
      { dataOperations: { create: false, update: true, delete: false }, fields: [], buttons: [] },
      MODULE_OBJECTS.organization.code,
    );
    expect(denied.status).toBe(400);
    await makeGrantable(world, [profile.id]);
    await grant(world, outsider.id, profile.id);
    const res = await world.api.request('GET', '/api/tenant/org/settings', {
      user: outsider.id,
      tenant: world.tenant.id,
    });
    expect(res.status).toBe(403);
  });

  it('任职配置写（tenant.employment.configuration.write）：可编辑任职记录的业务身份 403，租户管理员通过', async () => {
    const editor = await addMember(world, 'emp-config');
    await grant(world, editor.id, (await profileFor('emp-config', MODULE_OBJECTS.employmentRecord.code, true)).id);
    const put = (who: { user: string; tenant: string }) =>
      world.api.request('PUT', '/api/tenant/employment/settings', { ...who, ifMatch: 0, body: {} });
    expect((await put({ user: editor.id, tenant: world.tenant.id })).status).toBe(403);
    const asAdmin = await put(world.asAdmin);
    expect(asAdmin.status).toBe(400);
    expect(await errorCode(asAdmin)).toBe('VALIDATION_FAILED');
  });
});
