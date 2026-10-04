/** AC-PRM-17/18/21：身份绕过、应用元数据与关系/消费侧配置的真实管理端点。 */
import { randomUUID } from 'node:crypto';
import { employmentEmployees, permissionGrants, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  type PermissionWorld,
} from './AC-PRM-support.js';

const testDb = useTestDb();
const objectCode = MODULE_OBJECTS.employmentRecord.code;
describe('AC-PRM-17/18/21 范围消费规则与关系管理API', () => {
  let world: PermissionWorld;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });
  async function person() {
    const id = randomUUID();
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.insert(employmentEmployees).values({ id, tenantId: world.tenant.id, code: `person-${id}`, name: '合成人员' }),
    );
    return id;
  }
  const put = (path: string, body: unknown, ifMatch = 0, idempotencyKey?: string) =>
    world.api.request('PUT', `${BASE}${path}`, {
      ...world.asAdmin,
      ifMatch,
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

  it('身份seeAll首次必须显式配置，支持自身revision及幂等，拒绝跨应用目标', async () => {
    const profile = await createProfile(world, 'scope-all-policy');
    const path = `/profiles/${profile.id}/data-scopes/TenantBase`;
    const key = randomUUID();
    const body = { targetKind: 'app', targetCode: '', seeAll: true };
    const response = await put(path, body, 0, key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ seeAll: true, revision: 1 });
    expect((await put(path, body, 0, key)).status).toBe(200);
    expect((await put(path, { ...body, seeAll: false }, 0)).status).toBe(409);
    expect((await put(path, { ...body, seeAll: false }, 1)).status).toBe(200);
    const get = await world.api.request('GET', `${BASE}${path}`, world.asAdmin);
    expect(await get.json()).toMatchObject({ seeAll: false, revision: 2 });
    expect((await put(path, { targetKind: 'entity', targetCode: 'Demo.SalaryItem', seeAll: true })).status).toBe(400);
    expect((await put(`/profiles/${profile.id}/data-scopes/DemoPayroll`, body)).status).toBe(400);
  });

  it('应用allowedKinds控制赋值，未授管理员不能更改应用族', async () => {
    const user = await addMember(world, 'app-scope-target');
    const path = '/scope-apps/AttendanceDemo';
    const body = { family: 'attendance', allowedKinds: ['default'] };
    const result = await put(path, body);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ family: 'attendance', allowedKinds: ['default'], revision: 1 });
    expect((await put(path, body, 0)).status).toBe(409);
    const scope = await put(`/scopes/${user.id}/AttendanceDemo`, { kind: 'org_range', orgRanges: [] });
    expect(scope.status).toBe(400);
    const denied = await world.api.request('PUT', `${BASE}${path}`, {
      user: user.id,
      tenant: world.tenant.id,
      ifMatch: 1,
      body: { family: 'hr', allowedKinds: ['default', 'org_range'] },
    });
    expect(denied.status).toBe(403);
  });

  // DEC-128 推翻了 R1-T02 的“管理员显式绑定”：绑定只由建档 / 入职写入（AC-PRM-31/32），接口只读。
  it('用户-人员绑定接口只读：PUT / DELETE 一律 403，GET 返回未绑定', async () => {
    const user = await addMember(world, 'person-link');
    const employeeId = await person();
    const path = `/person-links/${user.id}`;
    expect((await put(path, { employeeId })).status).toBe(403);
    const removed = await world.api.request('DELETE', `${BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body: {} });
    expect(removed.status).toBe(403);
    const get = await world.api.request('GET', `${BASE}${path}`, world.asAdmin);
    expect(await get.json()).toMatchObject({ userId: user.id, employeeId: null, revision: 0 });
  });

  it('动态组织角色只关联auto授权，支持撤销与revision', async () => {
    const user = await addMember(world, 'dynamic-org');
    const profile = await createProfile(world, 'dynamic-org-profile');
    await makeGrantable(world, [profile.id]);
    const manual = await grant(world, user.id, profile.id);
    const manualId = ((await manual.json()) as { id: string }).id;
    expect((await put(`/dynamic-org-grants/${manualId}`, { roleCode: 'head' })).status).toBe(400);
    const autoProfile = await createProfile(world, 'dynamic-auto-profile');
    const [auto] = await withTenant(world.db, world.tenant.id, (tx) =>
      tx
        .insert(permissionGrants)
        .values({
          tenantId: world.tenant.id,
          userId: user.id,
          profileId: autoProfile.id,
          source: 'auto',
        })
        .returning(),
    );
    const path = `/dynamic-org-grants/${auto!.id}`;
    expect((await put(path, { roleCode: 'head' })).status).toBe(200);
    const get = await world.api.request('GET', `${BASE}${path}`, world.asAdmin);
    expect(await get.json()).toMatchObject({ roleCode: 'head', revision: 1 });
    const removed = await world.api.request('DELETE', `${BASE}${path}`, { ...world.asAdmin, ifMatch: 1, body: {} });
    expect(removed.status).toBe(200);
    expect((await put(path, { roleCode: 'hrbp' }, 0)).status).toBe(409);
  });

  it('实体/页面规则保存多个维度与显式空规则，拒绝改鉴权字段和无效规则', async () => {
    const path = `/scope-policies/TenantBase/${objectCode}/entity/${objectCode}`;
    const body = {
      personField: 'employeeId',
      departmentField: 'departmentId',
      rules: [{ dimension: 'management' }, { dimension: 'organization', roleCode: 'head' }],
    };
    const saved = await put(path, body);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      personField: 'employeeId',
      departmentField: 'departmentId',
      revision: 1,
    });
    expect((await put(path, { ...body, departmentField: 'remarks' }, 1)).status).toBe(400);
    expect((await put(path, { ...body, rules: [{ dimension: 'reporting' }] }, 1)).status).toBe(400);
    const page = `/scope-policies/TenantBase/${objectCode}/page/${objectCode}.list`;
    expect((await put(page, { rules: [] })).status).toBe(200);
    const get = await world.api.request('GET', `${BASE}${page}`, world.asAdmin);
    expect(await get.json()).toMatchObject({
      targetKind: 'page',
      targetCode: `${objectCode}.list`,
      rules: [],
      revision: 1,
    });
    expect(
      (await put(page, { rules: Array.from({ length: 21 }, () => ({ dimension: 'management' })) }, 1)).status,
    ).toBe(400);
  });
});
