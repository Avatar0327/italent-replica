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
  it('删除父级持锁未提交时新建下级等待；删除提交后新建按父级不存在拒绝', async () => {
    const { db } = testDb();
    const world = await seedPermissionWorld(db);
    const created = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `P_${randomUUID().slice(0, 8)}`, name: '父级', orgRanges: [] },
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

    const child = { code: `C_${randomUUID().slice(0, 8)}`, name: '下级', parentId: parent.id, description: '' };
    const creating = withTenant(db, world.tenant.id, (tx) =>
      createMou(tx, write(), { ...child, status: 'active', orgRanges: [] }, 0),
    ).then(
      () => 'created',
      (error: unknown) => error,
    );
    await waitForBlocked(db, 1);
    release();
    await deleting;
    expect(await creating).toMatchObject({ code: 'NOT_FOUND' });

    const orphans = await withTenant(db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM permission_mous WHERE parent_id=${parent.id}::uuid`),
    );
    expect(Number(rowsOf<{ n: number }>(orphans)[0]?.n)).toBe(0);
  });
});
