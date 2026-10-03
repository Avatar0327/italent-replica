/**
 * R1-T01 的跨模块接入回归，按 DEC-080 纠正旧占位授权预期。
 * 业务列表与租户配置使用不同的授权入口；仅有 update 不代表可 create。
 * 无业务身份的租户管理员仍不可读取业务数据；空数据范围不会由身份自动放大。
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
  { name: '组织', object: MODULE_OBJECTS.organization.code, settings: '/api/tenant/org/organizations' },
  { name: '职务', object: MODULE_OBJECTS.jobPost.code, settings: '/api/tenant/job/posts' },
  { name: '编制', object: MODULE_OBJECTS.establishment.code, settings: '/api/tenant/establishment/schemes' },
  { name: '任职', object: MODULE_OBJECTS.employee.code, settings: '/api/tenant/employment/employees' },
] as const;

/** 创建入口：未授 create 时应在请求体解析之前返回 403。 */
const WRITES = {
  组织: { method: 'POST', path: '/api/tenant/org/organizations' },
  职务: { method: 'POST', path: '/api/tenant/job/posts' },
  编制: { method: 'POST', path: '/api/tenant/establishment/schemes' },
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
    it(`${module.name}：无身份 403；只读身份可读不可写；仅编辑身份不可新增`, async () => {
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
      // DEC-080：create 不再错误地由 update 开关放行，保留原用例并纠正旧占位接线预期。
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('FORBIDDEN');
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
