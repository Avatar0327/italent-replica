/** 真 PostgreSQL 锁交错测试的共用辅助：数锁等待者、等“请求结束或恰有 N 个会话在等锁”（PGlite 单连接无法并发）。 */
import { sql, type Db, type Tx } from '@italent/db';
import { rowsOf } from './f048.js';

export async function lockWaiters(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  return Number(row?.n);
}

/** 等到请求结束或恰有 expected 个会话在等锁，返回先发生的那一个。 */
export async function settledOrBlocked(db: Db, request: Promise<unknown>, expected: number) {
  let settled = false;
  void request.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200; i++) {
    if (settled) return 'settled';
    if ((await lockWaiters(db)) === expected) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待请求结束或 ${expected} 个会话阻塞超时`);
}

const POLL_MS = 25;

/** timeoutMs 默认 5 秒；要验证“等待失败后的清理”时传小值，不必真的等满。 */
export async function waitForBlocked(db: Db, expected: number, timeoutMs = 5_000) {
  for (let i = 0; i < Math.ceil(timeoutMs / POLL_MS); i++) {
    if ((await lockWaiters(db)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`等待 ${expected} 个会话阻塞超时`);
}

export interface HeldLockSpec {
  /** 开持锁事务（带租户的用例传 `(fn) => withTenant(db, tenantId, fn)`）。 */
  run: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R>;
  /** 在持锁事务里取锁；取锁出错时 withHeldLock 直接抛出，不会卡在等“已持锁”。 */
  take: (tx: Tx) => Promise<unknown>;
  /** 放锁之后、持锁事务提交之前还要做的事（例如“先持组织锁、再锁成员行”的第二步）。 */
  afterRelease?: (tx: Tx) => Promise<void>;
}

export interface HeldLock {
  /** 登记在途请求并原样返回它：收束时无论成败都会等它结束，拒绝由调用方自己 await 时再取。 */
  track: <R>(request: Promise<R>) => Promise<R>;
}

/**
 * 测试会话持住一把锁，期间执行 body（发请求、waitForBlocked、探针……）；无论 body 成功、断言失败、
 * waitForBlocked 超时还是请求被提前拒绝，退出时都无条件放锁、等持锁事务结束、等已登记的在途请求落定（F-282）。
 * 否则持锁事务不结束，afterAll 的 handle.close() 会一直等它（vitest 60 秒钩子超时）并留下测试库。
 * body 自身的错误优先抛出；body 成功而持锁事务出错（含 afterRelease）则抛持锁事务的错。
 */
export async function withHeldLock<T>(spec: HeldLockSpec, body: (lock: HeldLock) => Promise<T>): Promise<T> {
  let release!: () => void;
  let held!: () => void;
  const hold = new Promise<void>((done) => (release = done));
  const locked = new Promise<void>((done) => (held = done));
  const holder = spec.run(async (tx) => {
    await spec.take(tx);
    held();
    await hold;
    await spec.afterRelease?.(tx);
  });
  const inFlight: Promise<unknown>[] = [];
  let outcome: { value: T } | { error: unknown };
  try {
    await Promise.race([locked, holder]);
    const track: HeldLock['track'] = (request) => {
      request.catch(() => undefined); // 等待期间先被拒绝不算未处理的 rejection
      inFlight.push(request);
      return request;
    };
    outcome = { value: await body({ track }) };
  } catch (error) {
    outcome = { error };
  }
  release();
  const [holderEnd] = await Promise.allSettled([holder, ...inFlight]);
  if ('error' in outcome) throw outcome.error;
  if (holderEnd.status === 'rejected') throw holderEnd.reason;
  return outcome.value;
}
