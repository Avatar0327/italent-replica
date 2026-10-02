/**
 * 身份 × 应用边界（REQ-PRM-001「身份按身份 × 应用授权」；Codex 审计 PR #8 第 1 条）：
 * - 配置身份对象权限时，对象所属应用必须在该身份登记的应用内，否则 400（OBJECT_OUTSIDE_PROFILE_APPS）；
 * - 判定时同样只认登记了对象所属应用的身份（库里即便存在越界的对象权限行，也不生效）。
 */
import { createPermissionAuthorizer } from '@italent/api';
import { permissionProfileObjects, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  myObject,
  OTHER_APP_OBJECT,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';

const testDb = useTestDb();
const ALL_OPS = { create: true, update: true, delete: true };

describe('身份对象权限受“身份 × 应用”边界约束', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  it('身份未登记对象所属应用 → 配置被拒（400，revision 不变）；登记了该应用 → 可配置', async () => {
    const coreOnly = await createProfile(world, 'core-only', { apps: ['TenantBase'] });
    const before = coreOnly.revision;
    const denied = await setObjectPermission(
      world,
      coreOnly,
      { dataOperations: ALL_OPS, fields: [{ fieldCode: 'Amount', view: true, edit: true }], buttons: [] },
      OTHER_APP_OBJECT.code,
    );
    expect(denied.status).toBe(400);
    const body = (await denied.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual([
      { reason: 'OBJECT_OUTSIDE_PROFILE_APPS', objectCode: OTHER_APP_OBJECT.code, application: 'DemoPayroll' },
    ]);
    expect(coreOnly.revision).toBe(before);

    const payroll = await createProfile(world, 'payroll', { apps: ['TenantBase', 'DemoPayroll'] });
    const ok = await setObjectPermission(
      world,
      payroll,
      { dataOperations: ALL_OPS, fields: [{ fieldCode: 'Amount', view: true, edit: true }], buttons: [] },
      OTHER_APP_OBJECT.code,
    );
    expect(ok.status).toBe(200);
  });

  it('判定按应用边界：越界的对象权限行不生效（me 403、授权器拒绝）；边界内的身份照常放行', async () => {
    const coreOnly = await createProfile(world, 'core-dirty', { apps: ['TenantBase'] });
    // 模拟越界脏数据（如历史导入）：绕过接口直接写一条不属于该身份应用的对象权限
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.insert(permissionProfileObjects).values({
        tenantId: world.tenant.id,
        profileId: coreOnly.id,
        objectCode: OTHER_APP_OBJECT.code,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      }),
    );
    await makeGrantable(world, [coreOnly.id]);
    const user = await addMember(world, 'boundary');
    expect((await grant(world, user.id, coreOnly.id)).status).toBe(201);

    const authorize = createPermissionAuthorizer(world.db);
    const base = { userId: user.id, tenantId: world.tenant.id, resource: OTHER_APP_OBJECT.code };
    expect(await authorize({ ...base, action: 'object.view' })).toBe(false);
    expect(await authorize({ ...base, action: 'object.delete' })).toBe(false);
    expect((await myObject(world, user, OTHER_APP_OBJECT.code)).status).toBe(403);

    const payroll = await createProfile(world, 'payroll-viewer', { apps: ['DemoPayroll'] });
    await setObjectPermission(
      world,
      payroll,
      { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [] },
      OTHER_APP_OBJECT.code,
    );
    await makeGrantable(world, [payroll.id]);
    expect((await grant(world, user.id, payroll.id)).status).toBe(201);
    expect(await authorize({ ...base, action: 'object.view' })).toBe(true);
    // 并集只含边界内的身份：越界那条的「删除」不计入
    expect(await authorize({ ...base, action: 'object.delete' })).toBe(false);
  });
});
