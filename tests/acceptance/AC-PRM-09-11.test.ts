/**
 * 企业设置 · 授权管理与许可管理（R1-T15；REQ-PRM-003；06 §4、§7.1）。
 * - AC-PRM-09（复刻自定，待编排会话登记 DEC）：许可余额为 0（或尚未发放）时授予消耗该类许可的身份 → 拒绝并提示余额不足，
 *   授权不落库、余额不变。判断收在 licenses.ts 一处。
 * - AC-PRM-11：自动授权产生的身份不允许手工撤销。
 * - 许可管理：余额（租户 / 系统 / 计费管理员）、使用明细（租户 / 计费管理员）；授权选择器带出许可类型以便显示余额（R3）。
 */
import { setLicenseQuota } from '@italent/api';
import { permissionGrants, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  seedPermissionWorld,
} from './AC-PRM-support.js';
import { memberWithAdminRole, reasonOf } from './AC-PRM-users-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();

interface Balance {
  licenseType: string;
  quota: number;
  used: number;
  balance: number;
}

describe('AC-PRM-09 许可余额为 0 时授予该类身份', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  async function balanceOf(licenseType: string): Promise<Balance | undefined> {
    const res = await world.api.request('GET', `${BASE}/licenses`, world.asAdmin);
    return ((await res.json()) as { items: Balance[] }).items.find((i) => i.licenseType === licenseType);
  }

  it('余额用尽 → 409 LICENSE_EXHAUSTED，授权不落库、余额不变；已占名额的用户再授同类身份不受影响', async () => {
    const pool = { tenantId: world.tenant.id, licenseType: 'core_hr', quota: 1, expectedRevision: 0 };
    await setLicenseQuota(testDb().db, pool, cmd());
    const core = await createProfile(world, 'core-admin', { licenseType: 'core_hr' });
    const core2 = await createProfile(world, 'core-viewer', { licenseType: 'core_hr' });
    await makeGrantable(world, [core.id, core2.id]);
    const first = await addMember(world, 'first');
    expect((await grant(world, first.id, core.id)).status).toBe(201);
    expect(await balanceOf('core_hr')).toMatchObject({ quota: 1, used: 1, balance: 0 });

    const second = await addMember(world, 'second');
    const denied = await grant(world, second.id, core.id);
    expect(await reasonOf(denied)).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'LICENSE_EXHAUSTED' });
    const listed = await world.api.request('GET', `${BASE}/grants?userId=${second.id}`, world.asAdmin);
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
    expect(await balanceOf('core_hr')).toMatchObject({ used: 1, balance: 0 });

    // W-123：已占用该类许可的用户再授同类身份不再消耗，余额为 0 也照常授予
    expect((await grant(world, first.id, core2.id)).status).toBe(201);
  });

  it('许可尚未发放（无许可池）→ 同样按余额不足拒绝', async () => {
    const pa = await createProfile(world, 'pa-user', { licenseType: 'pa_user' });
    await makeGrantable(world, [pa.id]);
    const user = await addMember(world, 'no-pool');
    expect(await reasonOf(await grant(world, user.id, pa.id))).toMatchObject({
      status: 409,
      reason: 'LICENSE_EXHAUSTED',
    });
  });
});

describe('AC-PRM-11 自动授权产生的身份不允许手工撤销', () => {
  it('撤销 source=auto 的授权 → 403 AUTO_GRANT，授权保持有效', async () => {
    const world = await seedPermissionWorld(testDb().db);
    const profile = await createProfile(world, 'self-service-manager');
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, 'auto-holder');
    const [auto] = await withTenant(world.db, world.tenant.id, (tx) =>
      tx
        .insert(permissionGrants)
        .values({ tenantId: world.tenant.id, userId: user.id, profileId: profile.id, source: 'auto' })
        .returning(),
    );
    const res = await world.api.request('POST', `${BASE}/grants/${auto!.id}/revoke`, {
      ...world.asAdmin,
      ifMatch: auto!.revision,
    });
    expect(await reasonOf(res)).toMatchObject({ status: 403, code: 'FORBIDDEN', reason: 'AUTO_GRANT' });
    const listed = await world.api.request('GET', `${BASE}/grants?userId=${user.id}`, world.asAdmin);
    expect(((await listed.json()) as { items: { status: string; source: string }[] }).items).toEqual([
      expect.objectContaining({ status: 'active', source: 'auto' }),
    ]);
  });
});

describe('许可管理：余额与使用明细（06 §7.1）', () => {
  let world: PermissionWorld;
  let profileId: string;
  let holder: string;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    const pool = { tenantId: world.tenant.id, licenseType: 'digital_talent', quota: 10, expectedRevision: 0 };
    await setLicenseQuota(testDb().db, pool, cmd());
    const profile = await createProfile(world, 'talent', { licenseType: 'digital_talent' });
    profileId = profile.id;
    await makeGrantable(world, [profile.id]);
    holder = (await addMember(world, 'seat-holder')).id;
    expect((await grant(world, holder, profile.id)).status).toBe(201);
  });

  it('授权选择器带出身份的许可类型（授权界面显示余额，REQ-PRM-003 R3）', async () => {
    const res = await world.api.request('GET', `${BASE}/grantable-profiles`, world.asAdmin);
    const items = ((await res.json()) as { items: { id: string; licenseType: string | null }[] }).items;
    expect(items.find((p) => p.id === profileId)).toMatchObject({ licenseType: 'digital_talent' });
  });

  it('使用明细列出占用名额的用户、授权与消耗时间；只有租户 / 计费管理员可看', async () => {
    const path = `${BASE}/licenses/digital_talent/seats`;
    const res = await world.api.request('GET', path, world.asAdmin);
    expect(res.status, await res.clone().text()).toBe(200);
    const items = ((await res.json()) as { items: { userId: string; profileId: string; consumedAt: string }[] }).items;
    expect(items).toEqual([expect.objectContaining({ userId: holder, profileId })]);

    const billing = await memberWithAdminRole(world, 'billing_admin');
    expect((await world.api.request('GET', path, billing.as)).status).toBe(200);
    expect((await world.api.request('GET', `${BASE}/licenses`, billing.as)).status).toBe(200);

    const system = await memberWithAdminRole(world, 'system_admin');
    expect((await world.api.request('GET', `${BASE}/licenses`, system.as)).status).toBe(200);
    expect((await world.api.request('GET', path, system.as)).status).toBe(403);
  });

  it('未发放的许可类型、非法类型编码 → 404', async () => {
    expect((await world.api.request('GET', `${BASE}/licenses/unknown_type/seats`, world.asAdmin)).status).toBe(404);
    expect((await world.api.request('GET', `${BASE}/licenses/Bad-Type/seats`, world.asAdmin)).status).toBe(404);
  });
});
