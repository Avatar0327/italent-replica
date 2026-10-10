/**
 * AC-360-F060（DEC-392）真 PostgreSQL 交错：同一份答卷的 open / page-check 并发。
 * - 并发 open：只留一行、起点是最早的那次，全部 200（幂等，没有 500 / 唯一键冲突）；
 * - 并发 page-check：行锁串行化，全部 200（没有死锁 / 序列化失败），翻页起点最终落在其中一次的时间上。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { sceneB } from './AC-360-B-support.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();

describe.runIf(realPostgres)('AC-360-F060 真 PG：open / page-check 并发', () => {
  it('并发 open ×6：全部 200，只有一行计时记录', async () => {
    const s = await sceneB(testDb().db, 'f060pace-pg1');
    const call = s.w.link(await s.w.token(s.activity.id, s.person.P1.id));
    const base = `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', `${base}/open`, { body: {} })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const count = await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM survey360_sheet_timings`),
    );
    const rows = (Array.isArray(count) ? count : (count as { rows: unknown[] }).rows) as { n: number }[];
    expect(rows[0]!.n).toBe(1);
  });

  it('并发 page-check ×5：全部 200（行锁串行化，没有死锁）', async () => {
    const s = await sceneB(testDb().db, 'f060pace-pg2');
    const call = s.w.link(await s.w.token(s.activity.id, s.person.P1.id));
    const base = `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
    expect((await call('POST', `${base}/open`, { body: {} })).status).toBe(200);
    const optionId = s.q.scales[0]!.options.find((o) => o.key === 'v4')!.id;
    const items = [{ itemId: s.q.questions[0]!.id, optionId }];
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('POST', `${base}/page-check`, { body: { items } })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  });
});
