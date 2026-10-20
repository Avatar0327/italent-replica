/**
 * 管理单元“删除父级 × 新建下级”并发（R1-T15，astra 首审 P3）：新建与删除走同一把层级锁，
 * 删除父级先持锁未提交时，新建下级须等待；删除提交后读到父级已删除而拒绝，不会留下指向已删除父级的有效下级。
 * 真 PostgreSQL 强制交错（PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createMou, updateMou } from '../../apps/api/src/modules/permission/data-scope-admin.js';
import { BASE, seedPermissionWorld } from './AC-PRM-support.js';
import { idleInTransaction } from './support/pg-interleave.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** 等到恰有 expected 个会话在等锁。 */
async function waitForBlocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (Number(row?.n) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

describe.skipIf(!realPostgres)('管理单元：删除父级 × 新建下级（真 PG 交错）', () => {
  /** expectedBlocked 默认 1；失败路径回归注入一个不符的人数，模拟“等待阻塞超时”。 */
  async function deleteThenCreate(expectedBlocked = 1) {
    const { db } = testDb();
    const world = await seedPermissionWorld(db);
    const created = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `P_${uniqueSuffix()}`, name: '父级', orgRanges: [] },
    });
    expect(created.status).toBe(201);
    const parent = (await created.json()) as { id: string; revision: number };
    const write = () => ({
      tenantId: world.tenant.id,
      userId: world.admin.id,
      now: new Date(),
      commandId: randomUUID(),
    });

    let deleted!: () => void;
    let release!: () => void;
    const deletedSignal = new Promise<void>((resolve) => (deleted = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deleting = withTenant(db, world.tenant.id, async (tx) => {
      await updateMou(tx, write(), parent.id, parent.revision, null);
      deleted();
      await gate;
    });
    await deletedSignal;

    const child = { code: `C_${uniqueSuffix()}`, name: '下级', parentId: parent.id, description: '' };
    const creating = withTenant(db, world.tenant.id, (tx) =>
      createMou(tx, write(), { ...child, status: 'active', orgRanges: [] }, 0),
    ).then(
      () => 'created',
      (error: unknown) => error,
    );
    await waitForBlocked(db, expectedBlocked);
    release();
    await deleting;
    expect(await creating).toMatchObject({ code: 'NOT_FOUND' });

    const orphans = await withTenant(db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM permission_mous WHERE parent_id=${parent.id}::uuid`),
    );
    expect(Number(rowsOf<{ n: number }>(orphans)[0]?.n)).toBe(0);
  }

  it('删除父级持锁未提交时新建下级等待；删除提交后新建按父级不存在拒绝', () => deleteThenCreate());

  it('失败路径（F-282）：阻塞人数不符、等待超时后，不留着持锁事务（无“事务内空闲”会话）', async () => {
    await expect(deleteThenCreate(2)).rejects.toThrow('超时');
    expect(await idleInTransaction(testDb().db), '持锁事务应已结束').toBe(0);
  });
});
