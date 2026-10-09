/**
 * AC-TR-08-matrix-deadlock-pg · PR #182 第 1 轮 P2-01：两个九宫格同时改位置字段、互占对方字段，
 * 各自先删旧占用再插新占用，互相等待对方事务 → 40P01 死锁（500）。位置字段的写入口按统一顺序取占用锁，
 * 只会得到受控的占用冲突（409）或成功，没有死锁、完整回滚。用行锁屏障让两个修改同时放行（真 PG；PGlite 单连接无法并发）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { MATRICES, matrixBody, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
type Role = 'before' | 'after';
const fieldOf = (m: MatrixView, role: Role) => m.positionFields.find((row) => row.role === role)!.fieldId;
const other = (role: Role): Role => (role === 'before' ? 'after' : 'before');

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('位置字段互换 · PostgreSQL 16 死锁', () => {
  it.each([
    ['before↔before', 'before', 'before'],
    ['after↔after', 'after', 'after'],
    ['before↔after', 'before', 'after'],
    ['after↔before', 'after', 'before'],
  ] as const)('两个九宫格互占对方字段 · %s：只有 200 / 409，无 500，位置字段不重复、各自完整', async (_n, x, y) => {
    const w = await matrixWorld(testDb().db, `trm-dl-${x}-${y}`);
    for (let round = 0; round < 3; round += 1) {
      const a = await w.create();
      const b = await w.create();
      const patch = (m: MatrixView, role: Role, taken: string) =>
        w.request('PATCH', `${MATRICES}/${m.id}`, {
          ifMatch: 1,
          body: {
            positionFields: [
              { role, fieldId: taken },
              { role: other(role), fieldId: fieldOf(m, other(role)) },
            ],
          },
        });
      const responses = await withTenant(testDb().db, w.as.tenant, async (tx) => {
        await tx.execute(
          sql`SELECT id FROM talent_review_matrices WHERE id IN (${a.id}::uuid, ${b.id}::uuid) FOR UPDATE`,
        );
        const pa = patch(a, x, fieldOf(b, x));
        const pb = patch(b, y, fieldOf(a, y));
        await waitForBlocked(testDb().db, 2);
        return [pa, pb] as const;
      });
      const settled = await Promise.all(responses);
      for (const response of settled) expect([200, 409], await response.clone().text()).toContain(response.status);
      const now = [(await w.read(a.id)).body, (await w.read(b.id)).body];
      const claimed = now.flatMap((m) => m.positionFields.map((row) => row.fieldId));
      expect(new Set(claimed).size).toBe(4);
      for (const m of now) expect(m.positionFields.map((row) => row.role).sort()).toEqual(['after', 'before']);
    }
  });

  it('两个新建同时按相反顺序占用同一对位置字段：一成一败（409），无死锁', async () => {
    const w = await matrixWorld(testDb().db, 'trm-dl-create');
    const f1 = (await w.positionField()).id;
    const f2 = (await w.positionField()).id;
    const build = async (before: string, after: string) => matrixBody({ ...(await w.refs()), before, after });
    const [c1, c2] = await Promise.all([build(f1, f2), build(f2, f1)]);
    const responses = await Promise.all([w.post(c1), w.post(c2)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});
