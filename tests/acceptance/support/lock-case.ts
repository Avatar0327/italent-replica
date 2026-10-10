/**
 * 咨询锁键的大小写交错测试支架（F-078，#182 第 4 轮同类排查）：租户中间件按原样保留 X-Tenant-Id 的大小写，
 * 同一租户的大小写变体若直接拼进锁键文本，会得到不同的锁、等于没有锁。测试用小写键文本做“持锁方”（和各取锁处的键格式一致），
 * 再让真实的取锁函数用**大写**的租户 / 对象 UUID 去取同一把锁：规范化后它必须排在持锁方后面（咨询锁等待），
 * 没规范化就不会等、测试在等待处超时失败。真 PostgreSQL（PGlite 单连接无法并发）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { expect } from 'vitest';

/** 含 a–f 字母的 UUID（大小写变体确实不同），小写。 */
export function uuidWithLetters(): string {
  for (;;) {
    const value = randomUUID();
    if (/[a-f]/.test(value)) return value;
  }
}
export const variants = (id: string) => {
  expect(id.toUpperCase()).not.toBe(id);
  return { lower: id, upper: id.toUpperCase() };
};

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

async function advisoryWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND l.locktype = 'advisory' AND a.datname = current_database()`),
  );
  return Number(row?.n);
}

async function waitForAdvisoryWaiter(db: Db) {
  for (let i = 0; i < 200; i += 1) {
    if ((await advisoryWaiters(db)) === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('大写变体没有在咨询锁上等待：锁键没有规范化，等于没有锁');
}

/** 持锁方：与各取锁处相同的键文本（小写）；32 位 hashtext 用于 qualification 的旧键。 */
const hold = (tx: Tx, key: string, hash: 'hashtext' | 'hashtextextended') =>
  hash === 'hashtext'
    ? tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`)
    : tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

/**
 * 持锁方先拿到 `key`（小写键文本）；`run` 用大写 UUID 去取锁，必须在咨询锁上排队，持锁方提交后才继续，且正常完成。
 */
export async function expectSerializedBehind(
  db: Db,
  tenantId: string,
  key: string,
  run: (tx: Tx) => Promise<unknown>,
  hash: 'hashtext' | 'hashtextextended' = 'hashtextextended',
): Promise<void> {
  const queued = await withTenant(db, tenantId, async (holder) => {
    await hold(holder, key, hash);
    const pending = withTenant(db, tenantId, (tx) => run(tx)).then(
      () => 'done' as const,
      (error: unknown) => error,
    );
    await waitForAdvisoryWaiter(db);
    return { pending };
  });
  expect(await queued.pending).toBe('done');
}

/** 试取锁（不等待）的变体：持锁方持有时，大写变体的 tryLock 必须返回 false。 */
export async function expectTryLockRefused(
  db: Db,
  tenantId: string,
  key: string,
  tryLock: (tx: Tx) => Promise<boolean>,
): Promise<void> {
  await withTenant(db, tenantId, async (holder) => {
    await hold(holder, key, 'hashtextextended');
    const entered = await withTenant(db, tenantId, (tx) => tryLock(tx));
    expect(entered).toBe(false);
  });
}

/** 反向对照：另一个租户的取锁不受持锁方影响（规范化只合并同一 UUID 的大小写变体，不会让不同租户互相阻塞）。 */
export async function expectIndependent(
  db: Db,
  tenantId: string,
  key: string,
  run: (tx: Tx) => Promise<unknown>,
): Promise<void> {
  await withTenant(db, tenantId, async (holder) => {
    await hold(holder, key, 'hashtextextended');
    await withTenant(db, tenantId, (tx) => run(tx));
    expect(await advisoryWaiters(db)).toBe(0);
  });
}
