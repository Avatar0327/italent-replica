/**
 * AC-SC-01 并发（R3-T05 A2，设计 §7、R4-02；真 PostgreSQL 16——PGlite 单连接无法并发）：
 * 锁序 目标锁行 → 记录行（升序）下，写入口之间不死锁、不 500，结果只落在契约列出的几种：
 * - 同一目标同一继任者同一区间并发新增：恰好一个 201，另一个 409 SUCCESSION_DUPLICATE；
 * - 批量结束的记录顺序相反（[A,B] 与 [B,A]）并发：不死锁，一个 200，另一个 409（ALREADY_ENDED / REVISION_CONFLICT）；
 * - 批量结束 [A,B] 与删除 B 并发：不死锁、不 500，库里没有半结束的状态（A、B 要么都结束，要么 B 被删而整批 404）。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import { rowsOf } from './support/f048.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
type Failure = { error: { code: string; details?: { reason?: string } } };
const reasonOf = async (response: Response) => {
  const { error } = (await response.clone().json()) as Failure;
  return error.details?.reason ?? error.code;
};

pg('AC-SC-01 写入口并发（真 PG）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let seq = 0;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-write-pg');
    std = await w.standard();
  });

  const seed = async () => {
    const hired = await w.hire(`并发继任者${++seq}`, { departmentId: std.orgB.id });
    return w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: hired.id });
  };
  const end = (ids: string[]) =>
    w.request('POST', '/records/end', {
      body: { items: ids.map((id) => ({ id, expectedRevision: 1 })), endDate: '2026-09-30' },
    });
  const endDates = async (ids: string[]) =>
    rowsOf<{ id: string; end_date: string; deleted: boolean }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT id, end_date::text AS end_date, deleted_at IS NOT NULL AS deleted
          FROM succession_records WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])`),
      ),
    );

  it('同一区间并发新增：恰好一个 201，另一个 409 SUCCESSION_DUPLICATE', async () => {
    const hired = await w.hire(`并发新增${++seq}`, { departmentId: std.orgB.id });
    const body = {
      successionType: 'org',
      targetOrgId: std.orgA.id,
      successorEmployeeId: hired.id,
      startDate: '2026-09-01',
    };
    const results = await Promise.all([
      w.request('POST', '/records', { body }),
      w.request('POST', '/records', { body }),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((response) => response.status === 409)!;
    expect(await reasonOf(loser)).toBe('SUCCESSION_DUPLICATE');
  });

  it('批量结束的记录顺序相反并发：不死锁，一个 200，另一个 409', async () => {
    const [a, b] = [await seed(), await seed()];
    const results = await Promise.all([end([a, b]), end([b, a])]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = results.find((response) => response.status === 409)!;
    expect(['ALREADY_ENDED', 'REVISION_CONFLICT']).toContain(await reasonOf(loser));
    for (const row of await endDates([a, b])) expect(row.end_date).toBe('2026-09-30');
  });

  it('批量结束 [A,B] 与删除 B 并发：不死锁、不 500，没有半结束状态', async () => {
    const [a, b] = [await seed(), await seed()];
    const results = await Promise.all([end([a, b]), w.request('DELETE', `/records/${b}`, { ifMatch: 1 })]);
    for (const response of results) expect([200, 404, 409], await response.clone().text()).toContain(response.status);
    const rows = new Map((await endDates([a, b])).map((row) => [row.id, row]));
    const bothEnded = rows.get(a)!.end_date === '2026-09-30' && rows.get(b)!.end_date === '2026-09-30';
    const bDeleted = rows.get(b)!.deleted;
    // 要么两条都结束（删除排在后面，B 因 revision 已变 409 或在结束后被删），要么 B 先被删、整批 404 而 A 未结束
    expect(bothEnded || (bDeleted && rows.get(a)!.end_date !== '2026-09-30')).toBe(true);
  });
});
