/**
 * 企业设置 · 授权管理与许可管理（R1-T15；REQ-PRM-003；06 §4、§7.1）。
 * - AC-PRM-09 / DEC-143：许可余额为 0（或尚未发放）时仍允许授予消耗该类许可的身份，余额记为负数，授权响应带可机读的
 *   超额提示（licenseOverage），许可余额标出超额；已占名额再授同类身份不消耗，但仍按当前余额提示超额；
 *   判断收在 licenses.ts 一处。
 * - AC-PRM-11：自动授权产生的身份不允许手工撤销。
 * - DEC-141：撤销已消耗许可的身份时归还名额（余额 = 发放总数 − 仍在用的名额）；同一用户还持有同类身份时名额不释放。
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
  overage: boolean;
}

describe('AC-PRM-09 / DEC-143 许可余额为 0 时仍允许授予并提示超额', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  async function balanceOf(licenseType: string): Promise<Balance | undefined> {
    const res = await world.api.request('GET', `${BASE}/licenses`, world.asAdmin);
    return ((await res.json()) as { items: Balance[] }).items.find((i) => i.licenseType === licenseType);
  }

  it('余额 0 → 授予成功、余额 -1、响应带超额提示；撤销后按 DEC-141 归还为 0', async () => {
    const pool = { tenantId: world.tenant.id, licenseType: 'core_hr', quota: 1, expectedRevision: 0 };
    await setLicenseQuota(testDb().db, pool, cmd());
    const core = await createProfile(world, 'core-admin', { licenseType: 'core_hr' });
    const core2 = await createProfile(world, 'core-viewer', { licenseType: 'core_hr' });
    await makeGrantable(world, [core.id, core2.id]);
    const first = await addMember(world, 'first');
    const within = await grant(world, first.id, core.id);
    expect(within.status).toBe(201);
    expect(await within.json()).toMatchObject({ licenseOverage: null });
    expect(await balanceOf('core_hr')).toMatchObject({ quota: 1, used: 1, balance: 0, overage: false });

    const second = await addMember(world, 'second');
    const over = await grant(world, second.id, core.id);
    expect(over.status, await over.clone().text()).toBe(201);
    const created = (await over.json()) as { id: string; revision: number; licenseOverage: unknown };
    expect(created.licenseOverage).toEqual({
      code: 'LICENSE_OVERAGE',
      licenseType: 'core_hr',
      quota: 1,
      used: 2,
      balance: -1,
    });
    expect(await balanceOf('core_hr')).toMatchObject({ quota: 1, used: 2, balance: -1, overage: true });

    // 配额 1、两人各占一席（余额 -1）→ 给其中一人再授同类第二身份：不再消耗名额（W-123），
    // 但当前仍超额，响应照样带超额提示（DEC-143 没有“已有名额不提示”的例外），与余额接口一致
    const again = await grant(world, first.id, core2.id);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { licenseOverage: unknown }).licenseOverage).toEqual({
      code: 'LICENSE_OVERAGE',
      licenseType: 'core_hr',
      quota: 1,
      used: 2,
      balance: -1,
    });
    expect(await balanceOf('core_hr')).toMatchObject({ quota: 1, used: 2, balance: -1, overage: true });

    const revoked = await world.api.request('POST', `${BASE}/grants/${created.id}/revoke`, {
      ...world.asAdmin,
      ifMatch: created.revision,
    });
    expect(revoked.status).toBe(200);
    expect(await balanceOf('core_hr')).toMatchObject({ quota: 1, used: 1, balance: 0, overage: false });
  });

  it('许可尚未发放（无许可池）→ 同样照常授予，余额按总量 0 记为 -1 并提示超额', async () => {
    const pa = await createProfile(world, 'pa-user', { licenseType: 'pa_user' });
    await makeGrantable(world, [pa.id]);
    const user = await addMember(world, 'no-pool');
    const res = await grant(world, user.id, pa.id);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({
      licenseOverage: { code: 'LICENSE_OVERAGE', licenseType: 'pa_user', quota: 0, used: 1, balance: -1 },
    });
    expect(await balanceOf('pa_user')).toMatchObject({ quota: 0, used: 1, balance: -1, overage: true });
  });
});

describe('DEC-141 撤销已消耗许可的身份时归还名额', () => {
  it('同类身份都撤销后才释放名额；释放后余额恢复，名额可再授给他人', async () => {
    const world = await seedPermissionWorld(testDb().db);
    const pool = { tenantId: world.tenant.id, licenseType: 'pa_user', quota: 1, expectedRevision: 0 };
    await setLicenseQuota(testDb().db, pool, cmd());
    const first = await createProfile(world, 'pa-a', { licenseType: 'pa_user' });
    const second = await createProfile(world, 'pa-b', { licenseType: 'pa_user' });
    await makeGrantable(world, [first.id, second.id]);
    const holder = await addMember(world, 'pa-holder');
    const grantA = (await (await grant(world, holder.id, first.id)).json()) as { id: string; revision: number };
    const grantB = (await (await grant(world, holder.id, second.id)).json()) as { id: string; revision: number };
    const balance = async () => {
      const res = await world.api.request('GET', `${BASE}/licenses`, world.asAdmin);
      return ((await res.json()) as { items: Balance[] }).items.find((i) => i.licenseType === 'pa_user');
    };
    const revoke = (g: { id: string; revision: number }) =>
      world.api.request('POST', `${BASE}/grants/${g.id}/revoke`, { ...world.asAdmin, ifMatch: g.revision });
    expect(await balance()).toMatchObject({ used: 1, balance: 0 });
    const other = await addMember(world, 'pa-waiting');

    // 撤销最先消耗名额的授权：仍持有同类身份 B，名额不释放，使用明细改记在 B 上
    expect((await revoke(grantA)).status).toBe(200);
    expect(await balance()).toMatchObject({ used: 1, balance: 0 });
    const seats = await world.api.request('GET', `${BASE}/licenses/pa_user/seats`, world.asAdmin);
    expect(((await seats.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ userId: holder.id, grantId: grantB.id, profileId: second.id }),
    ]);

    expect((await revoke(grantB)).status).toBe(200);
    expect(await balance()).toMatchObject({ used: 0, balance: 1 });
    const reused = await grant(world, other.id, first.id);
    expect(reused.status).toBe(201);
    expect(await reused.json()).toMatchObject({ licenseOverage: null });
    expect(await balance()).toMatchObject({ used: 1, balance: 0 });
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
