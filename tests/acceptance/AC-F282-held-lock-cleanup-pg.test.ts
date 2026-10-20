/**
 * F-282（#457 F-257 R1 P3）持锁事务提前拒绝后的正常清理（真 PostgreSQL）：
 * 锁序类用例让测试会话先持住一把锁，再等请求停在锁上；请求若在拿锁前就被拒绝，等待超时抛错，
 * 旧写法没有 finally 放锁，持锁事务一直不结束，afterAll 里 handle.close() 卡住（vitest 60 秒钩子超时）并留下测试库。
 * 本用例用独立测试库复现“提前拒绝 + 等待失败”，要求随后关库立即完成、测试库被删除。
 */
import { createPgDb, type Db, sql } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { waitForBlocked } from './support/pg-interleave.js';

const CLOSE_BUDGET_MS = 10_000;

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

async function databaseExists(name: string): Promise<boolean> {
  const admin = createPgDb(process.env.TEST_DATABASE_URL!, { max: 1 });
  try {
    return rowsOf(await admin.db.execute(sql`SELECT 1 FROM pg_database WHERE datname=${name}`)).length > 0;
  } finally {
    await admin.close();
  }
}

async function currentDatabase(db: Db): Promise<string> {
  return rowsOf<{ name: string }>(await db.execute(sql`SELECT current_database() AS name`))[0]!.name;
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-F282 持锁事务提前拒绝后的清理（真 PG）', () => {
  it('请求在拿锁前被拒绝、等待阻塞超时：持锁事务不留着，关库在预算内完成且测试库被删除', async () => {
    const handle = await createTestDb();
    const name = await currentDatabase(handle.db);
    let release!: () => void;
    let held!: () => void;
    const hold = new Promise<void>((done) => (release = done));
    const locked = new Promise<void>((done) => (held = done));
    const holder = handle.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('f282-early-reject', 0))`);
      held();
      await hold;
    });
    try {
      await locked;
      const request = Promise.reject(new Error('提前拒绝：没有走到取锁'));
      request.catch(() => undefined);
      await expect(waitForBlocked(handle.db, 1)).rejects.toThrow('超时');
      // 旧写法：这里抛错后直接离开用例，release() 没被调用
    } finally {
      // 仅为让本进程能退出；下面的断言量的是“不放锁时关库的表现”
      const closing = Promise.race([
        handle.close().then(() => 'closed' as const),
        new Promise<'hung'>((done) => setTimeout(() => done('hung'), CLOSE_BUDGET_MS)),
      ]);
      const outcome = await closing;
      release();
      await holder;
      if (outcome === 'hung') await handle.close();
      expect(outcome, '持锁事务未结束时关库卡住').toBe('closed');
      expect(await databaseExists(name), '测试库应已删除').toBe(false);
    }
  }, 60_000);
});
