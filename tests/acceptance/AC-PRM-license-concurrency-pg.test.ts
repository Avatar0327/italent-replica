/**
 * 并发撤销同一用户的两条同类授权（R1-T15，astra 第二轮 P3）：撤销 A 时名额改记到 B（更新 license_seats.grant_id
 * 要对 B 取外键共享锁）。若撤销先锁授权行、后取许可锁，“A 持许可锁等 B 行 / B 持 B 行等许可锁”会形成死锁环。
 * 统一取锁顺序：撤销先取该类许可锁，再锁授权行——后到的撤销在许可锁上排队，此时还没锁任何授权行。
 * 真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 */
import { randomUUID } from 'node:crypto';
import { setLicenseQuota } from '@italent/api';
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { revokeGrant } from '../../apps/api/src/modules/permission/grants.js';
import { listBalances, listSeats } from '../../apps/api/src/modules/permission/licenses.js';
import { addMember, createProfile, grant, makeGrantable, seedPermissionWorld } from './AC-PRM-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** 等到恰有 expected 个会话在等锁，返回它们等的锁类型。 */
async function waitForBlocked(db: Db, expected: number): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    const waiting = rowsOf<{ locktype: string }>(
      await db.execute(sql`SELECT l.locktype FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`),
    );
    if (waiting.length === expected) return waiting.map((w) => w.locktype);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

describe.skipIf(!realPostgres)('并发撤销同一用户的两条同类授权（真 PG 交错）', () => {
  it('后到的撤销在许可锁上等待（未锁授权行），先到的提交后继续，名额最终归还', async () => {
    const { db } = testDb();
    const world = await seedPermissionWorld(db);
    const pool = { tenantId: world.tenant.id, licenseType: 'core_hr', quota: 1, expectedRevision: 0 };
    await setLicenseQuota(db, pool, cmd());
    const first = await createProfile(world, 'core-a', { licenseType: 'core_hr' });
    const second = await createProfile(world, 'core-b', { licenseType: 'core_hr' });
    await makeGrantable(world, [first.id, second.id]);
    const holder = await addMember(world, 'holder');
    type Created = { id: string; revision: number };
    const grantA = (await (await grant(world, holder.id, first.id)).json()) as Created;
    const grantB = (await (await grant(world, holder.id, second.id)).json()) as Created;
    const write = () => ({
      tenantId: world.tenant.id,
      userId: world.admin.id,
      now: new Date(),
      commandId: randomUUID(),
    });

    let revokedA!: () => void;
    let release!: () => void;
    const revokedASignal = new Promise<void>((resolve) => (revokedA = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    // A 撤销完成但未提交：持有许可锁、A 行锁，以及名额改记到 B 时对 B 行的外键共享锁
    const revokingA = withTenant(db, world.tenant.id, async (tx) => {
      await revokeGrant(tx, write(), { grantId: grantA.id, expectedRevision: grantA.revision });
      revokedA();
      await gate;
    });
    await revokedASignal;

    const revokingB = withTenant(db, world.tenant.id, (tx) =>
      revokeGrant(tx, write(), { grantId: grantB.id, expectedRevision: grantB.revision }),
    );
    expect(await waitForBlocked(db, 1)).toEqual(['advisory']);
    release();
    await revokingA;
    expect(await revokingB).toMatchObject({ id: grantB.id, status: 'revoked' });

    const after = await withTenant(db, world.tenant.id, async (tx) => ({
      balances: await listBalances(tx),
      seats: await listSeats(tx, 'core_hr', { limit: 10, offset: 0 }),
    }));
    expect(after.seats).toEqual([]);
    expect(after.balances).toEqual([expect.objectContaining({ licenseType: 'core_hr', used: 0, balance: 1 })]);
  });
});
