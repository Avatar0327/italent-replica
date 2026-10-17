/**
 * BE-14b2 并发同步恰好一条待入职（真 PG）：两个“立即同步”带同一 revision 同时到达，Offer 行锁串行化——
 * 一个 200，另一个 409（revision 已变）；夜间任务与手动同步交错时同样只生成一条。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOfferSyncSweep } from '../../apps/api/src/modules/offer/sync-scheduler.js';
import { syncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
const count = async (w: Awaited<ReturnType<typeof syncWorld>>, offerId: string) => {
  const result = await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`SELECT
      (SELECT count(*) FROM employment_employees WHERE code = ${`OFR-${offerId}`})::int AS employees,
      (SELECT count(*) FROM audit_events WHERE object_id = ${offerId} AND action = 'offer.sync')::int AS syncs`),
  );
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0] as {
    employees: number;
    syncs: number;
  };
};

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('并发同步恰好一条待入职（真 PG）', () => {
  it('两个立即同步同时到达：一个成功一个 409，只建一个人员、一条待入职、一条同步审计', async () => {
    const w = await syncWorld(testDb().db, 'sync-race');
    await w.timing({ enabled: false });
    const offer = await w.accepted(await w.social());
    const responses = await Promise.all([w.sync(offer), w.sync(offer)]);
    expect(responses.map((r) => r.status).sort(), '一个成功、一个版本冲突').toEqual([200, 409]);
    expect(await w.entries()).toHaveLength(1);
    expect(await count(w, offer.id)).toEqual({ employees: 1, syncs: 1 });
    expect(await w.read(offer.id)).toMatchObject({ syncStatus: 'success', syncAttempts: 1, hasPendingEntry: true });
  });

  it('立即同步与夜间任务同时到达：只生成一条', async () => {
    const w = await syncWorld(testDb().db, 'sync-race-sweep');
    await w.timing({ mode: 'on_accept_within_days', days: 90 });
    // 先关开关造出“已接受未同步”，再恢复时机让夜间任务认为到期
    await w.timing({ enabled: false });
    const offer = await w.accepted(await w.social());
    await w.timing({ mode: 'on_accept_within_days', days: 90 });
    const [manual, sweep] = await Promise.all([
      w.sync(offer),
      runOfferSyncSweep(w.db, { clock: () => new Date('2026-10-18T04:00:00.000Z') }),
    ]);
    expect([200, 409]).toContain(manual.status);
    expect(sweep.errors).toEqual([]);
    expect(await w.entries()).toHaveLength(1);
    expect((await count(w, offer.id)).employees).toBe(1);
    expect(await w.read(offer.id)).toMatchObject({ syncStatus: 'success', hasPendingEntry: true });
  });
});
