/**
 * F-282（#457 F-257 R1 P3）持锁事务无条件放锁（真 PostgreSQL）：
 * 锁序类用例让测试会话先持住一把锁，再等请求停在锁上；请求若在拿锁前就被拒绝，等待超时抛错，
 * 旧写法没有 finally 放锁，持锁事务一直不结束，afterAll 里 handle.close() 卡住（vitest 60 秒钩子超时）并留下测试库。
 * withHeldLock 保证 body 成功、断言失败、等待超时、请求提前拒绝时都放锁并收束在途请求。
 */
import { createPgDb, type Db, sql, type Tx } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { SHORT_WAIT_MS, waitForBlocked, withHeldLock } from './support/pg-interleave.js';

const CLOSE_BUDGET_MS = 10_000;

const testDb = useTestDb();

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const advisory = (tx: Tx, key: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
const spec = (db: Db, key: string) => ({ run: db.transaction.bind(db) as never, take: (tx: Tx) => advisory(tx, key) });

async function lockIsFree(db: Db, key: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = rowsOf<{ ok: boolean }>(
      await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS ok`),
    );
    return rows[0]!.ok;
  });
}

async function databaseExists(name: string): Promise<boolean> {
  const admin = createPgDb(process.env.TEST_DATABASE_URL!, { max: 1 });
  try {
    return rowsOf(await admin.db.execute(sql`SELECT 1 FROM pg_database WHERE datname=${name}`)).length > 0;
  } finally {
    await admin.close();
  }
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-F282 持锁事务无条件放锁（真 PG）', () => {
  it('请求在拿锁前被拒绝、等待阻塞超时：抛出等待错误，关库在预算内完成且测试库被删除', async () => {
    const handle = await createTestDb();
    const name = rowsOf<{ name: string }>(await handle.db.execute(sql`SELECT current_database() AS name`))[0]!.name;
    let closing: Promise<'closed' | 'hung'> | undefined;
    try {
      await expect(
        withHeldLock(spec(handle.db, 'f282-early-reject'), async (lock) => {
          lock.track(Promise.reject(new Error('提前拒绝：没有走到取锁')));
          await waitForBlocked(handle.db, 1, SHORT_WAIT_MS);
        }),
      ).rejects.toThrow('超时');
    } finally {
      closing = Promise.race([
        handle.close().then(() => 'closed' as const),
        new Promise<'hung'>((done) => setTimeout(() => done('hung'), CLOSE_BUDGET_MS)),
      ]);
    }
    expect(await closing, '持锁事务未结束时关库卡住').toBe('closed');
    expect(await databaseExists(name), '测试库应已删除').toBe(false);
  }, 60_000);

  it('请求已停在锁上但等待人数不符（超时）：放锁后在途请求落定，锁已释放', async () => {
    const { db } = testDb();
    let request!: Promise<string>;
    await expect(
      withHeldLock(spec(db, 'f282-count-mismatch'), async (lock) => {
        request = lock.track(db.transaction(async (tx) => (await advisory(tx, 'f282-count-mismatch'), 'done')));
        await waitForBlocked(db, 2, SHORT_WAIT_MS);
      }),
    ).rejects.toThrow('超时');
    expect(await request, '放锁后请求应正常完成').toBe('done');
    expect(await lockIsFree(db, 'f282-count-mismatch')).toBe(true);
  });

  it('body 内断言失败：原断言错误原样抛出，锁已释放', async () => {
    const { db } = testDb();
    await expect(
      withHeldLock(spec(db, 'f282-assert'), async () => {
        expect('预期', '断言失败不得吞掉').toBe('实际');
      }),
    ).rejects.toThrow('断言失败不得吞掉');
    expect(await lockIsFree(db, 'f282-assert')).toBe(true);
  });

  it('body 成功：返回 body 的值；放锁后才执行 afterRelease，其错误在 body 成功时抛出', async () => {
    const { db } = testDb();
    const order: string[] = [];
    const value = await withHeldLock(
      {
        ...spec(db, 'f282-ok'),
        afterRelease: async () => {
          order.push('afterRelease');
        },
      },
      async () => {
        order.push('body');
        return 42;
      },
    );
    expect(value).toBe(42);
    expect(order).toEqual(['body', 'afterRelease']);
    await expect(
      withHeldLock(
        {
          ...spec(db, 'f282-after-fail'),
          afterRelease: async () => {
            throw new Error('放锁后步骤失败');
          },
        },
        async () => undefined,
      ),
    ).rejects.toThrow('放锁后步骤失败');
    expect(await lockIsFree(db, 'f282-after-fail')).toBe(true);
  });

  it('取锁本身出错：直接抛出，不卡在等“已持锁”', async () => {
    await expect(
      withHeldLock(
        { run: testDb().db.transaction.bind(testDb().db) as never, take: () => Promise.reject(new Error('取锁失败')) },
        async () => 'unreachable',
      ),
    ).rejects.toThrow('取锁失败');
  });
});
