/**
 * AC-PRM-08（REQ-PRM-003 R2）：授予身份 → 消耗一个许可证名额（原站数字人才余额 493 → 492）。
 * 给已持有同类许可的用户再授一个同类身份，许可不变（W-123）；不消耗许可的身份不占名额。
 * 许可总量由平台方发放（L0，runPlatformCommand，带 revision）。
 */
import { setLicenseQuota } from '@italent/api';
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
import { cmd, errorCode } from './support/tenant-api.js';

const testDb = useTestDb();

interface LicenseBody {
  items: { licenseType: string; quota: number; used: number; balance: number; revision: number }[];
}

describe('AC-PRM-08 授予身份消耗许可证名额', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  async function balance(): Promise<LicenseBody['items'][number] | undefined> {
    const res = await world.api.request('GET', `${BASE}/licenses`, world.asAdmin);
    expect(res.status).toBe(200);
    return ((await res.json()) as LicenseBody).items.find((i) => i.licenseType === 'digital_talent');
  }

  it('余额 493 → 授权后 492；同一用户再授同类身份不变；不消耗许可的身份不占名额', async () => {
    const pool = { tenantId: world.tenant.id, licenseType: 'digital_talent', quota: 493, expectedRevision: 0 };
    await setLicenseQuota(testDb().db, pool, cmd());
    expect(await balance()).toMatchObject({ quota: 493, used: 0, balance: 493 });

    const talent = await createProfile(world, 'talent-admin', { licenseType: 'digital_talent' });
    const talent2 = await createProfile(world, 'talent-viewer', { licenseType: 'digital_talent' });
    const free = await createProfile(world, 'free');
    await makeGrantable(world, [talent.id, talent2.id, free.id]);
    const user = await addMember(world, 'a4');

    expect((await grant(world, user.id, talent.id)).status).toBe(201);
    expect(await balance()).toMatchObject({ used: 1, balance: 492 });
    expect((await grant(world, user.id, talent2.id)).status).toBe(201);
    expect((await grant(world, user.id, free.id)).status).toBe(201);
    expect(await balance()).toMatchObject({ used: 1, balance: 492 });

    const other = await addMember(world, 'a5');
    expect((await grant(world, other.id, talent2.id)).status).toBe(201);
    expect(await balance()).toMatchObject({ used: 2, balance: 491 });
  });

  it('平台调整许可总量必须带 revision；旧 revision → 冲突', async () => {
    const { db } = testDb();
    const current = await balance();
    const change = { tenantId: world.tenant.id, licenseType: 'digital_talent', quota: 600 };
    await expect(setLicenseQuota(db, { ...change, expectedRevision: 0 }, cmd())).rejects.toThrow(/revision/);
    await setLicenseQuota(db, { ...change, expectedRevision: current!.revision }, cmd());
    expect(await balance()).toMatchObject({ quota: 600, used: 2, balance: 598 });
  });

  it('只有租户 / 系统 / 计费管理员能看余额（06 §7.1）', async () => {
    const employee = await addMember(world, 'employee');
    const res = await world.api.request('GET', `${BASE}/licenses`, { user: employee.id, tenant: world.tenant.id });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('FORBIDDEN');
  });
});
