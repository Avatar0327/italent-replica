/**
 * BE-14b2 并发同步恰好一条待入职（真 PG）：两个“立即同步”带同一 revision 同时到达，Offer 行锁串行化——
 * 一个 200，另一个 409（revision 已变）；夜间任务与手动同步交错时同样只生成一条。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOfferSyncSweep } from '../../apps/api/src/modules/offer/sync-scheduler.js';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { syncWorld, type SyncOffer } from './AC-OF-BE14b2-support.js';
import { settledOrBlocked } from './support/pg-interleave.js';

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

/** 在另一个会话里持有 Offer 行锁，直到调用 release()。 */
async function holdOfferLock(w: Awaited<ReturnType<typeof syncWorld>>, offerId: string) {
  let release!: () => void;
  let held!: () => void;
  const heldPromise = new Promise<void>((resolve) => (held = resolve));
  const holder = withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`SELECT id FROM offers WHERE id = ${offerId}::uuid FOR UPDATE`);
    held();
    await new Promise<void>((resolve) => (release = resolve));
  });
  await heldPromise;
  return async () => {
    release();
    await holder;
  };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  '恢复路径先锁 Offer 再锁员工 / 业务（与 #406 重发同序，真 PG）',
  () => {
    it('已取消入职改期恢复时，Offer 行被他人持有：恢复请求在等 Offer 锁，此时不持有员工、业务行锁', async () => {
      const w = await syncWorld(testDb().db, 'sync-lock-order');
      const synced = await w.accepted(await w.social());
      const entryId = synced.pendingEntryBusinessId!;
      expect((await w.entryAction(entryId, 'cancel', {})).status).toBe(200);
      const employeeId = (await w.record(entryId)).employeeId;

      const releaseLock = await holdOfferLock(w, synced.id);
      let restore: Promise<Response> | undefined;
      try {
        restore = w.entryAction(entryId, 'postpone', { effectiveDate: '2026-11-15' });
        expect(await settledOrBlocked(w.db, restore, 1)).toBe('blocked');
        // 恢复请求此刻只在等 Offer 锁：员工行、待入职业务行都还能被别人立即锁住（NOWAIT 不报 55P03）
        await withTenant(w.db, w.tenant.id, async (tx) => {
          await tx.execute(
            sql`SELECT id FROM employment_employees WHERE id = ${employeeId}::uuid FOR NO KEY UPDATE NOWAIT`,
          );
          await tx.execute(
            sql`SELECT id FROM employment_business_objects WHERE id = ${entryId}::uuid FOR UPDATE NOWAIT`,
          );
        });
      } finally {
        await releaseLock();
      }
      expect((await restore!).status).toBe(200);
    });
  },
);

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('合 main 收口：发送 × 同步、重发 × 恢复交错（真 PG）', () => {
  it('发送 × 同步：Offer 行被占时，发送与立即同步都在等 Offer 锁；释放后发送成功并同步，立即同步只会 409，全程无 40P01 / 55P03', async () => {
    const w = await syncWorld(testDb().db, 'sync-send-race');
    await w.timing({ mode: 'on_send' });
    const target = await w.social();
    const other = await w.social();
    const releaseLock = await holdOfferLock(w, target.id);
    const both = Promise.all([w.send(target), w.sync(target)]);
    try {
      const peer = await w.send(other); // 另一份 Offer 的发送不受影响
      expect(peer.status, await peer.clone().text()).toBe(200);
      expect(await settledOrBlocked(w.db, both, 2)).toBe('blocked');
    } finally {
      await releaseLock();
    }
    const [sent, synced] = await both;
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await sent.json()).toMatchObject({ status: 'sent', syncStatus: 'success', hasPendingEntry: true });
    expect(synced.status).toBe(409);
    expect((await w.entries()).length).toBe(2);
  });

  it('重发 × 恢复：Offer 行被占时，重发与改期恢复都在等 Offer 锁且不持有员工 / 业务锁；释放后恢复成功，重发成功或 409，无 40P01 / 55P03', async () => {
    const w = await syncWorld(testDb().db, 'resend-restore-race');
    await w.timing({ mode: 'on_send' });
    const sent = (await (await w.send(await w.social())).json()) as SyncOffer;
    const entryId = sent.pendingEntryBusinessId!;
    expect((await w.entryAction(entryId, 'cancel', {})).status).toBe(200);
    const employeeId = (await w.record(entryId)).employeeId;
    const current = await w.read(sent.id);
    const releaseLock = await holdOfferLock(w, sent.id);
    const both = Promise.all([w.send(current), w.entryAction(entryId, 'postpone', { effectiveDate: '2026-11-15' })]);
    try {
      expect(await settledOrBlocked(w.db, both, 2)).toBe('blocked');
      await withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(
          sql`SELECT id FROM employment_employees WHERE id = ${employeeId}::uuid FOR NO KEY UPDATE NOWAIT`,
        );
        await tx.execute(sql`SELECT id FROM employment_business_objects WHERE id = ${entryId}::uuid FOR UPDATE NOWAIT`);
      });
    } finally {
      await releaseLock();
    }
    const [resent, restored] = await both;
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect([200, 409]).toContain(resent.status);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  '第 4 轮 P2-2：跨 Offer、同一实习生的发送 × 立即同步（真 PG）',
  () => {
    /** 同一名在职实习生关联的 Offer：个人邮箱与账号一致，已关联。 */
    async function linkedOffer(w: Awaited<ReturnType<typeof syncWorld>>, intern: { id: string }) {
      const offer = await w.social({ personalEmail: loginEmailOf(intern.id), source: 'intern_conversion' });
      const linked = await w.request('POST', `/${offer.id}/link-employee`, {
        ifMatch: offer.revision,
        body: { employeeId: intern.id },
      });
      expect(linked.status, await linked.clone().text()).toBe(200);
      return (await linked.json()) as SyncOffer;
    }

    it('锁序 Offer → 员工 → 组织：员工行被占时，发送阻塞在员工锁上，此刻不持有组织设置锁（旧实现先取组织锁再等员工锁）', async () => {
      const w = await syncWorld(testDb().db, 'sync-lock-order-intern');
      await w.timing({ mode: 'on_send' });
      const intern = await w.internEmployee('在职实习生');
      const offer = await linkedOffer(w, intern);
      let release!: () => void;
      let held!: () => void;
      const heldPromise = new Promise<void>((resolve) => (held = resolve));
      const holder = withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(sql`SELECT id FROM employment_employees WHERE id = ${intern.id}::uuid FOR NO KEY UPDATE`);
        held();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await heldPromise;
      const send = w.send(offer);
      try {
        expect(await settledOrBlocked(w.db, send, 1)).toBe('blocked');
        await withTenant(w.db, w.tenant.id, async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
          await lockOrganizationSettings(tx, w.tenant.id); // 持有者若在等员工锁则这里超时（55P03）
        });
      } finally {
        release();
        await holder;
      }
      expect((await send).status).toBe(200);
    });

    it('发送 × 立即同步交错 3 轮（各用同一实习生的两份 Offer）：两个请求都是 200，没有死锁被包装成 409 / 5xx', async () => {
      const w = await syncWorld(testDb().db, 'sync-send-vs-sync-intern');
      for (let round = 0; round < 3; round++) {
        const intern = await w.internEmployee(`在职实习生${round}`);
        await w.timing({ enabled: false });
        const accepted = await w.accepted(await linkedOffer(w, intern));
        const toSend = await linkedOffer(w, intern);
        await w.timing({ enabled: true, mode: 'on_send' });
        const [sent, synced] = await Promise.all([w.send(toSend), w.sync(accepted)]);
        expect([sent.status, synced.status], (await sent.clone().text()) + (await synced.clone().text())).toEqual([
          200, 200,
        ]);
      }
    });
  },
);
