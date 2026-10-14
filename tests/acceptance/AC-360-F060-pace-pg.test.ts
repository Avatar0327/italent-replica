/**
 * AC-360-F060（DEC-392 / DEC-405）真 PostgreSQL 交错：同一份答卷的取页 / page-check 并发与两个标签页。
 * - 并发取作答页：只留一行计时、一条审计，起点不后移，全部 200（幂等，没有 500 / 唯一键冲突）；
 * - 两个标签页：后开的标签页不挪打开时刻；翻页起点跟着最后一次翻页走，与打开时刻是两个不同的值；
 * - 受控交错：关系行被另一事务占着时，两个 page-check 排队，放行后全部 200、打开时刻不动、翻页起点落在其中一次。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rows } from '../../apps/api/src/modules/survey360/context.js';
import { sceneB } from './AC-360-B-support.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
const T0 = Date.parse('2026-10-01T02:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到至少 n 个连接在等锁（关系行锁 / 咨询锁），确认请求确实被阻塞；超时则失败，不靠固定等待。 */
async function blockedRequests(n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = (await testDb().db.execute(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    )) as unknown;
    const list = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { n: number }[];
    if (list[0]!.n >= n) return;
    if (Date.now() > deadline) throw new Error(`等锁的连接不足 ${n} 个`);
    await sleep(50);
  }
}

async function scene(label: string) {
  const s = await sceneB(testDb().db, label);
  const call = s.w.link(await s.w.token(s.activity.id, s.person.P1.id));
  const base = `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
  const optionId = s.q.scales[0]!.options.find((o) => o.key === 'v4')!.id;
  const items = [{ itemId: s.q.questions[0]!.id, optionId }];
  const timing = async () =>
    rows<{ opened_at: string; page_started_at: string }>(
      await withTenant(testDb().db, s.w.tenantId, (tx) =>
        tx.execute(sql`SELECT opened_at, page_started_at FROM survey360_sheet_timings`),
      ),
    );
  const audits = async (action: string) =>
    rows<{ n: number }>(
      await withTenant(testDb().db, s.w.tenantId, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action}`),
      ),
    )[0]!.n;
  return { s, call, base, items, timing, audits };
}

describe.runIf(realPostgres)('AC-360-F060 真 PG：取页 / page-check 并发', () => {
  it('并发取作答页 ×6：全部 200，只有一行计时、一条建立审计，起点不后移', async () => {
    const { s, call, base, timing, audits } = await scene('f060pace-pg1');
    s.w.setNow(at(0));
    const results = await Promise.all(Array.from({ length: 6 }, () => call('GET', base)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const [row, ...rest] = await timing();
    expect(rest).toEqual([]);
    expect(new Date(row!.opened_at).toISOString()).toBe(at(0));
    expect(await audits('survey360.sheet-timing.open')).toBe(1);
  });

  it('并发 page-check ×5：全部 200（行锁串行化，没有死锁），每次翻页一条更新审计', async () => {
    const { s, call, base, items, audits } = await scene('f060pace-pg2');
    s.w.setNow(at(0));
    expect((await call('GET', base)).status).toBe(200);
    s.w.setNow(at(60_000));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('POST', `${base}/page-check`, { body: { items } })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await audits('survey360.sheet-timing.page')).toBe(5);
  });

  it('两个标签页：后开的不挪打开时刻；翻页起点与打开时刻是两个不同的值', async () => {
    const { s, call, base, items, timing } = await scene('f060pace-pg3');
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base)); // 标签页 A
    s.w.setNow(at(60_000));
    await s.w.ok(call('GET', base)); // 标签页 B：不挪起点
    s.w.setNow(at(61_000));
    const a = await s.w.ok<{ reminder: boolean }>(call('POST', `${base}/page-check`, { body: { items } }));
    expect(a.reminder).toBe(false); // 1 题，距打开 61 秒
    s.w.setNow(at(61_500));
    const b = await s.w.ok<{ reminder: boolean }>(call('POST', `${base}/page-check`, { body: { items } }));
    expect(b.reminder).toBe(true); // 距上一次翻页 0.5 秒
    const [row] = await timing();
    expect(new Date(row!.opened_at).toISOString()).toBe(at(0));
    expect(new Date(row!.page_started_at).toISOString()).toBe(at(61_500));
    // 提交按“打开 → 提交”：62 秒 / 3 题，不算过快；选项各不相同
    const options = s.q.scales[0]!.options;
    const answers = s.q.questions.map((q, i) => ({
      itemId: q.id,
      optionId: options.find((o) => o.key === ['v5', 'v4', 'v3'][i])!.id,
    }));
    s.w.setNow(at(61_900));
    const saved = await s.w.ok<{ revision: number }>(call('PUT', base, { ifMatch: 0, body: { answers } }));
    s.w.setNow(at(62_000));
    const done = await s.w.ok<{ reminder: boolean }>(call('POST', `${base}/submit`, { ifMatch: saved.revision }));
    expect(done.reminder).toBe(false); // 若打开时刻被翻页起点覆盖，0.5 秒会判过快
  });

  it('受控交错：关系行被占着时两个 page-check 先后排队，放行后按先后串行——翻页起点、提醒结果与审计条数都确定', async () => {
    const { s, call, base, items, timing, audits } = await scene('f060pace-pg4');
    s.w.setNow(at(0));
    await s.w.ok(call('GET', base));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = withTenant(testDb().db, s.w.tenantId, async (tx) => {
      await tx.execute(sql`SELECT id FROM survey360_relations WHERE id = ${s.rel.p1.id}::uuid FOR UPDATE`);
      held();
      await gate;
    });
    await holding;
    // 第 1 个请求在 100 秒取时钟，卡在关系行锁上（已确认确实被阻塞，不靠固定等待）
    s.w.setNow(at(100_000));
    const first = call('POST', `${base}/page-check`, { body: { items } });
    await blockedRequests(1);
    // 第 2 个请求在 100.4 秒取时钟，排在第 1 个后面（同评价者串行化的咨询锁）
    s.w.setNow(at(100_400));
    const second = call('POST', `${base}/page-check`, { body: { items } });
    await blockedRequests(2);
    release();
    await holder;
    const [one, two] = await Promise.all([first, second]);
    expect([one.status, two.status]).toEqual([200, 200]);
    // 先到先得：第 1 个距打开 100 秒 → 不提醒；第 2 个距第 1 个翻页 0.4 秒 → 提醒
    expect(((await one.json()) as { reminder: boolean }).reminder).toBe(false);
    expect(((await two.json()) as { reminder: boolean }).reminder).toBe(true);
    const [row] = await timing();
    expect(new Date(row!.opened_at).toISOString()).toBe(at(0));
    expect(new Date(row!.page_started_at).toISOString()).toBe(at(100_400));
    expect(await audits('survey360.sheet-timing.page')).toBe(2);
  });
});
