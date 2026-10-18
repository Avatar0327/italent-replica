/**
 * BE-14b3 联动 × 并发（真 PG，两连接强制交错）：锁序全程“批量单 → Offer → 员工 → 业务头”，不出现 40P01。
 * - F-219：被驳回批量单里并发“删除 B × 失效 A”：两者都先排在批量单锁上，等待期间不持有任何 Offer 行锁；
 * - 取消入职 × Offer 失效、办理入职 × 编辑并同步：Offer 行被占时两个请求都只在等 Offer 锁，员工 / 业务行此刻仍可被别人立即锁住。
 * 死锁用 pg_stat_database.deadlocks 计数前后对比判定（40P01 会被包装成 409，光看状态码看不出）。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';
import { syncWorld, type SyncWorld } from './AC-OF-BE14b2-support.js';
import { settledOrBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
const deadlocks = async (db: Db) =>
  Number(
    rows<{ n: string }>(
      await db.execute(sql`SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`),
    )[0]!.n,
  );

/** 在另一个会话里持有行锁直到 release()；sqlText 是返回要锁的行的 FOR UPDATE 语句。 */
async function holdLock(
  db: Db,
  tenantId: string,
  lock: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>,
) {
  let release!: () => void;
  let held!: () => void;
  const heldPromise = new Promise<void>((resolve) => (held = resolve));
  const holder = withTenant(db, tenantId, async (tx) => {
    await lock(tx);
    held();
    await new Promise<void>((resolve) => (release = resolve));
  });
  await heldPromise;
  return async () => {
    release();
    await holder;
  };
}

pg('F-219 被驳回批量单：并发删除 B × 失效 A', () => {
  it('两者都先等批量单锁、等待期间不持有 Offer 行锁；放开后无死锁，结果只有成功或 409 冲突', async () => {
    const w = await offerApprovalWorld(testDb().db, 'f219');
    const [a, b] = [await w.social(w.applicant), await w.social(w.applicant)];
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [a.id, b.id] }), 201);
    await w.decide(await w.instance(batch.id), w.manager, 'reject'); // 上级驳回：批量单待发起人处理
    const [ra, rb] = [await w.get(a.id), await w.get(b.id)];
    expect((await w.instance(batch.id)).status).toBe('returned'); // 在途（驳回待处理）批量单仍管着两份 Offer
    expect([ra.status, rb.status]).toEqual(['pending', 'pending']);

    const before = await deadlocks(w.db);
    const release = await holdLock(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT id FROM offer_batch_approvals WHERE id = ${batch.id}::uuid FOR UPDATE`),
    );
    const removal = w.request(w.applicant.userId, 'DELETE', `/api/tenant/offers/${rb.id}`, { ifMatch: rb.revision });
    const invalidation = w.invalidateRaw(ra);
    const both = Promise.all([removal, invalidation]);
    try {
      expect(await settledOrBlocked(w.db, both, 2)).toBe('blocked');
      // 两个请求此刻都只在等批量单：Offer A、B 的行都还能被别人立即锁住（旧锁序里删除一侧已持有 B 的行锁，这里会 55P03）
      await withTenant(w.db, w.tenant.id, async (tx) => {
        await tx.execute(sql`SELECT id FROM offers WHERE id IN (${ra.id}::uuid, ${rb.id}::uuid) FOR UPDATE NOWAIT`);
      });
    } finally {
      await release();
    }
    const [deleted, invalidated] = await both;
    expect([deleted.status, invalidated.status].every((status) => status === 200 || status === 409)).toBe(true);
    expect([deleted.status, invalidated.status]).toContain(200);
    expect(await deadlocks(w.db)).toBe(before);
    const final = (await w.get(ra.id)) as OfferView;
    expect(final.status).toBe(invalidated.status === 200 ? 'invalid' : 'pending');
  });
});

async function entrySetup(label: string) {
  const w = await syncWorld(testDb().db, label);
  const offer = await w.accepted(await w.social());
  const entryId = offer.pendingEntryBusinessId!;
  const employeeId = (await w.record(entryId)).employeeId;
  return { w, offer, entryId, employeeId };
}

/** 等待期间 Offer 行被占：员工行、待入职业务行仍可被别人立即锁住（请求没有先持员工 / 业务锁）。 */
async function expectNoEntryLocksHeld(w: SyncWorld, employeeId: string, entryId: string) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees WHERE id = ${employeeId}::uuid FOR NO KEY UPDATE NOWAIT`);
    await tx.execute(sql`SELECT id FROM employment_business_objects WHERE id = ${entryId}::uuid FOR UPDATE NOWAIT`);
  });
}

const holdOffer = (w: SyncWorld, offerId: string) =>
  holdLock(w.db, w.tenant.id, (tx) => tx.execute(sql`SELECT id FROM offers WHERE id = ${offerId}::uuid FOR UPDATE`));

pg('联动 × 并发', () => {
  it('取消入职 × Offer 失效：都先等 Offer 锁；放开后无死锁，最终不会出现“Offer 已失效而待入职还在”', async () => {
    const { w, offer, entryId, employeeId } = await entrySetup('cc-cancel-invalidate');
    const before = await deadlocks(w.db);
    const release = await holdOffer(w, offer.id);
    const cancel = w.entryAction(entryId, 'cancel', {});
    const invalidate = w.invalidate(offer, { reasonCode: 'candidate_gave_up' });
    const both = Promise.all([cancel, invalidate]);
    try {
      expect(await settledOrBlocked(w.db, both, 2)).toBe('blocked');
      await expectNoEntryLocksHeld(w, employeeId, entryId);
    } finally {
      await release();
    }
    const [cancelled, invalidated] = await both;
    expect([cancelled.status, invalidated.status].every((status) => [200, 404, 409].includes(status))).toBe(true);
    expect(await deadlocks(w.db)).toBe(before);
    const final = await w.read(offer.id);
    const live = (await w.entries()).filter((entry) => entry.employeeId === employeeId);
    if (final.status === 'invalid')
      expect(live).toEqual([]); // 失效赢：待入职已删除
    else expect(final.status).toBe('rejected'); // 取消赢：OF-R9 联动已拒绝，失效因状态不允许被拒
  });

  it('办理入职 × 编辑并同步：都先等 Offer 锁；放开后无死锁，Offer 终态与待入职一致', async () => {
    const { w, offer, entryId, employeeId } = await entrySetup('cc-complete-edit');
    const before = await deadlocks(w.db);
    const release = await holdOffer(w, offer.id);
    const complete = w.employment('POST', `/pending-entries/${entryId}/complete`, {
      ifMatch: await w.businessRevision(entryId),
      body: { probation: false },
    });
    const editing = w.request('PUT', `/${offer.id}`, {
      ifMatch: offer.revision,
      body: { plannedEntryDate: '2026-12-01', syncPendingEntry: true },
    });
    const both = Promise.all([complete, editing]);
    try {
      expect(await settledOrBlocked(w.db, both, 2)).toBe('blocked');
      await expectNoEntryLocksHeld(w, employeeId, entryId);
    } finally {
      await release();
    }
    const [completed, edited] = await both;
    expect([completed.status, edited.status].every((status) => [200, 404, 409].includes(status))).toBe(true);
    expect(await deadlocks(w.db)).toBe(before);
    const final = await w.read(offer.id);
    // 办理入职赢 → Offer 已入职，编辑被拒；编辑赢 → 待入职已换新记录，旧记录上的办理入职被拒，Offer 仍是已接受
    if (completed.status === 200) expect(final.status).toBe('onboarded');
    else expect(final).toMatchObject({ status: 'accepted', plannedEntryDate: '2026-12-01' });
  });
});
