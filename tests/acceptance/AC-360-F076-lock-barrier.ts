/**
 * F-076 真 PG 交错测试的屏障：一方在测试钩子处停住，另一方以“已在等锁”（pg_stat_activity 的 wait_event_type = Lock）
 * 或“已经完成”为准再放行，不按固定延时猜对方是否已到达取锁点（#234 第 2 轮审查 P3）。
 */
import { sql, type Db } from '@italent/db';
import { rowsOf } from './AC-360-F076-support.js';

/** 钩子闸门：reached() 标记已到达，arrived 等到达，release() 放行 wait。 */
export function gate() {
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { arrived, wait, reached: () => reached(), release: () => release() };
}

async function lockWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`),
  );
  return Number(row?.n ?? 0);
}

/**
 * 等到 promise 所在的请求已在等锁，或已经完成（成功、失败都算）；10 秒内都没有即失败——说明交错没有按预期发生。
 * 已完成的情形留给旧实现：它不取锁、直接提交，放行后即暴露错误结果。
 */
export async function blockedOrSettled(db: Db, promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 400; i += 1) {
    if (settled || (await lockWaiters(db)) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('交错的另一方既没有在等锁，也没有完成');
}
