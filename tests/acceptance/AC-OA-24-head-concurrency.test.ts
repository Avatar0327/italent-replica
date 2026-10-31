/**
 * AC-OA-24 头写入的真 PostgreSQL 锁屏障（F-340，#514 第 1 轮审查 P3 固化）：
 * - 取号：两个并发建单都排在“租户取号咨询锁”后面，放行后编码不同且连续（当日流水 0001 / 0002）；
 * - revision：两个并发改头（同一 If-Match）都排在申请单行锁后面，放行后只有一个 200，另一个 409，数据不被覆盖。
 * 屏障是确定性的：测试会话先持锁，按 pg_stat_activity 观察到“恰有 N 个会话在等锁”才发下一个请求 / 放锁，不靠延时。
 *
 * 观测连接的取法：直接用测试库连接池 `w.db` 执行查询（不进 withTenant）。这样观测会话的当前角色是登录角色
 * （本地 / 普通角色分片为 app_owner，超级用户分片为 postgres），与请求会话同一登录角色，且 app_owner 另有
 * pg_read_all_stats（scripts/pg-roles.sql），看得到其他会话的 wait_event_type 与语句。若在 withTenant 里观测，
 * 事务已 SET LOCAL ROLE app_user，其他会话的状态列一律为 NULL、等锁数恒为 0——审查首跑就因此没看到锁等待。
 * 所以：先断言观测连接能看全其他会话；等锁达不到预期人数时 waitForBlocked 超时抛错，不会静默通过。
 * PGlite 单连接无法并发，整组只在真 PG 运行。
 */
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { advisoryLock, asUuid } from '../../apps/api/src/advisory-lock.js';
import { type AdjustmentView, expectError, headWorld, type HeadWorld } from './AC-OA-head-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { type HeldLockSpec, waitForBlocked, withHeldLock } from './support/pg-interleave.js';

const testDb = useTestDb();

/**
 * 观测连接能否看全本库其他会话；返回可见 / 不可见数。无权查看的行除库名、用户外各列为 NULL
 * （含 state、backend_type、wait_event_type），语句显示为 '<insufficient privilege>'，所以按语句判可见性。
 */
async function visibility(db: Db | Tx) {
  const [row] = resultRows<{ visible: number; hidden: number }>(
    await db.execute(sql`SELECT count(*) FILTER (WHERE query <> '<insufficient privilege>')::int AS visible,
        count(*) FILTER (WHERE query = '<insufficient privilege>')::int AS hidden
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`),
  );
  return row!;
}

/** 持锁期间调用：至少看得到持锁会话，且一个不可见的都没有，否则后面的等锁计数不可信。 */
async function expectObserverSeesAll(db: Db) {
  const seen = await visibility(db);
  expect(seen, '观测连接看不全其他会话：须用不切换角色的连接池连接（登录角色本身或 pg_read_all_stats）').toEqual({
    visible: expect.any(Number) as number,
    hidden: 0,
  });
  expect(seen.visible).toBeGreaterThan(0);
}

/** 正在等锁的会话：未授予的锁类型 + 正在执行的语句（按 pid 排序）。 */
async function lockWaits(db: Db) {
  return resultRows<{ locktype: string; query: string }>(
    await db.execute(sql`SELECT l.locktype, a.query FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
      WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' ORDER BY a.pid`),
  );
}

/** 测试会话持取号咨询锁：与 service.ts nextCode 同一把锁（同一键构造）。 */
const codeLock = (w: HeadWorld): HeldLockSpec => ({
  run: (fn) => withTenant(w.db, w.tenant.id, fn),
  take: (tx) => advisoryLock(tx, 'org-adjustment-code:', asUuid(w.tenant.id)),
});

/** 测试会话持申请单行锁（独立 SQL，不借用被测的 loadAdjustment）。 */
const rowLock = (w: HeadWorld, id: string): HeldLockSpec => ({
  run: (fn) => withTenant(w.db, w.tenant.id, fn),
  take: (tx) => tx.execute(sql`SELECT id FROM org_adjustments WHERE id = ${id} FOR UPDATE`),
});

/** 持锁 → 逐个发请求，每发一个等到恰有 n 个会话在等锁 → 核对等的是哪把锁 → 放锁，返回各请求的响应。 */
async function queued(w: HeadWorld, spec: HeldLockSpec, requests: (() => Promise<Response>)[], waitingOn: RegExp) {
  const started = await withHeldLock(spec, async (session) => {
    await expectObserverSeesAll(w.db);
    const running: Promise<Response>[] = [];
    for (const [index, request] of requests.entries()) {
      running.push(session.track(request()));
      await waitForBlocked(w.db, index + 1);
    }
    const waits = await lockWaits(w.db);
    expect(waits).toHaveLength(requests.length);
    for (const wait of waits) expect(wait.query).toMatch(waitingOn);
    return running;
  });
  return Promise.all(started);
}

describe.skipIf(testDbMode() !== 'pg')('AC-OA-24 头写入并发（PG 专用，F-340：取号咨询锁 / 申请单行锁屏障）', () => {
  it('观测连接取法：连接池连接看得到等锁会话；withTenant 内（app_user）看不到，计数恒为 0', async () => {
    const w = await headWorld(testDb().db, 'oa24obs');
    await withHeldLock(codeLock(w), async (session) => {
      session.track(w.create());
      await waitForBlocked(w.db, 1);
      expect(await lockWaits(w.db)).toHaveLength(1);
      const inTenant = await withTenant(w.db, w.tenant.id, async (tx) => ({
        seen: await visibility(tx),
        waiting: resultRows<{ n: number }>(
          await tx.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`),
        )[0]!.n,
      }));
      expect(inTenant.waiting).toBe(0);
      expect(inTenant.seen.hidden).toBeGreaterThan(0);
    });
  });

  it('取号：两个并发建单都等在租户取号咨询锁上，放行后都 201，编码不同且连续（0001 / 0002）', async () => {
    const w = await headWorld(testDb().db, 'oa24code');
    const responses = await queued(w, codeLock(w), [() => w.create(), () => w.create()], /pg_advisory_xact_lock/);
    for (const res of responses) expect(res.status, await res.clone().text()).toBe(201);
    const codes = (await Promise.all(responses.map(async (r) => ((await r.json()) as AdjustmentView).code))).sort();
    const prefix = codes[0]!.slice(0, -4);
    expect(codes).toEqual([`${prefix}0001`, `${prefix}0002`]);
    const stored = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ code: string }>(await tx.execute(sql`SELECT code FROM org_adjustments ORDER BY code`)),
    );
    expect(stored.map((r) => r.code)).toEqual(codes);
  });

  it('revision：两个并发改头（同 If-Match 1）都等在申请单行锁上，放行后一个 200、一个 409，数据不被覆盖', async () => {
    const w = await headWorld(testDb().db, 'oa24rev');
    const v = await w.created();
    const responses = await queued(
      w,
      rowLock(w, v.id),
      [() => w.patch(v.id, { subject: '并发甲' }, 1), () => w.patch(v.id, { subject: '并发乙' }, 1)],
      /FROM org_adjustments[\s\S]*FOR UPDATE/,
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = responses.find((r) => r.status === 200)!;
    const loser = responses.find((r) => r.status === 409)!;
    await expectError(loser, 409, 'REVISION_CONFLICT');
    const won = (await winner.json()) as AdjustmentView;
    expect(won).toMatchObject({ revision: 2 });
    expect(await w.stored(v.id)).toMatchObject({ subject: won.subject, revision: 2, range: [w.a] });
    expect(await w.audits(v.id)).toEqual(['org-adjustment.create', 'org-adjustment.update']);
  });
});
