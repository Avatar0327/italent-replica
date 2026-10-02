/**
 * AC-PRM-01（REQ-PRM-001）：用户无某模块身份时直接请求该模块对象接口 → 后端拒绝（不只是菜单隐藏）。
 * 同时验证三层结构：L0 平台方开通第一位租户管理员（runPlatformCommand：幂等、同事务审计）；
 * L2 管理员能力按 8 类企业管理员矩阵判定；L3 业务身份决定对象功能权限。默认拒绝（fail-closed）。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { auditEvents, eq, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  DEMO_OBJECT,
  grant,
  makeGrantable,
  myObject,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { cmd, errorCode } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-PRM-01 无身份即后端拒绝；三层权限结构', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('普通成员（无任何身份）直接请求对象接口、身份管理、租户配置 → 403 FORBIDDEN', async () => {
    const employee = await addMember(world, 'employee');
    const as = { user: employee.id, tenant: world.tenant.id };

    const object = await myObject(world, employee);
    expect(object.status).toBe(403);
    expect(await errorCode(object)).toBe('FORBIDDEN');

    for (const path of [
      `${BASE}/profiles`,
      `${BASE}/grants`,
      `${BASE}/admins`,
      '/api/tenant/settings/audit.retention',
    ]) {
      const res = await world.api.request('GET', path, as);
      expect(res.status, path).toBe(403);
      expect(await errorCode(res)).toBe('FORBIDDEN');
    }
  });

  it('授予含该对象的业务身份（L3）后可访问；租户管理员（L2）没有业务身份同样不能访问业务对象', async () => {
    const hr = await addMember(world, 'hr');
    const profile = await createProfile(world, 'hr-admin');
    const set = await setObjectPermission(world, profile, {
      dataOperations: { create: false, update: false, delete: false },
      fields: [{ fieldCode: 'Name', view: true, edit: false }],
      buttons: [],
    });
    expect(set.status).toBe(200);

    expect((await myObject(world, hr)).status).toBe(403);
    expect((await myObject(world, world.admin)).status).toBe(403); // 管理员例外不作为业务默认（04 §5 第 7 条）

    await makeGrantable(world, [profile.id]);
    expect((await grant(world, hr.id, profile.id)).status).toBe(201);
    const after = await myObject(world, hr);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ objectCode: DEMO_OBJECT.code, viewableFields: ['Name'] });
  });

  it('L2：租户管理员可读身份管理与租户配置；审计管理员不能管身份（职责分离）', async () => {
    expect((await world.api.request('GET', `${BASE}/profiles`, world.asAdmin)).status).toBe(200);
    expect((await world.api.request('GET', '/api/tenant/settings/audit.retention', world.asAdmin)).status).toBe(200);

    const auditor = await addMember(world, 'auditor');
    const created = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: auditor.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(created.status).toBe(201);
    const asAuditor = { user: auditor.id, tenant: world.tenant.id };
    expect((await world.api.request('GET', `${BASE}/profiles`, asAuditor)).status).toBe(403);
    expect((await world.api.request('GET', `${BASE}/grants`, asAuditor)).status).toBe(403);
  });

  it('L0：平台开通租户管理员走平台命令——同命令 ID 重放幂等，审计写入该租户', async () => {
    const { db } = testDb();
    const other = await addMember(world, 'second-admin');
    const meta = cmd();
    const first = await bootstrapTenantAdmin(db, { tenantId: world.tenant.id, userId: other.id }, meta);
    const replay = await bootstrapTenantAdmin(db, { tenantId: world.tenant.id, userId: other.id }, meta);
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({ role: 'tenant_admin', revision: 1 });
    expect(first.grantableAdminRoles).toHaveLength(8);

    const events = await withTenant(db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, first.id)),
    );
    expect(events.map((e) => e.action)).toEqual(['permission_admin.bootstrap']);
    expect(events[0]?.commandId).toBe(meta.commandId);
  });
});
