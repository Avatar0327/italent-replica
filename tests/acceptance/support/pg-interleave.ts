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

/** 停在“事务内空闲”的会话数（持锁事务没结束的特征）；本连接不算。 */
export async function idleInTransaction(db: Db): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()`),
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

/** 失败路径回归用的短等待：注入不符的阻塞人数后不必真的等满默认的 5 秒。 */
export const SHORT_WAIT_MS = 200;

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

export interface HeldLockHandle extends HeldLock {
  /** 提前放锁并等持锁事务结束（幂等）；需要“放锁后继续断言”或多把锁错开放时用，退出时仍会兜底再放一次。 */
  release: () => Promise<void>;
}

/**
 * 单一清理入口（F-282）：执行 body；无论 body 成功、断言失败、waitForBlocked 超时还是请求被提前拒绝，
 * 退出时都无条件调用 release 放行，并等 settleAlso（持锁事务等）和已登记的在途请求落定。
 * 门不在测试自己开的事务里（锁由被 mock 暂停的请求自己持有）时，直接用本函数，release 传放行 mock 门的函数。
 * body 自身的错误优先抛出；其次是 release 的错误；最后才是 settleAlso 里的失败（在途请求的拒绝一律吞掉）。
 */
export async function withRelease<T>(
  release: () => void | Promise<void>,
  body: (lock: HeldLock) => Promise<T>,
  settleAlso: readonly Promise<unknown>[] = [], // 可在 body 执行期间继续追加
): Promise<T> {
  const inFlight: Promise<unknown>[] = [];
  const track: HeldLock['track'] = (request) => {
    request.catch(() => undefined); // 等待期间先被拒绝不算未处理的 rejection
    inFlight.push(request);
    return request;
  };
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await body({ track }) };
  } catch (error) {
    outcome = { error };
  }
  let releaseFailure: { error: unknown } | undefined;
  try {
    await release();
  } catch (error) {
    releaseFailure = { error };
  }
  const extra = [...settleAlso]; // settleAlso 可由钩子在 body 执行期间追加（持锁事务由被测流程中途启动时）
  const settled = await Promise.allSettled([...extra, ...inFlight]);
  if ('error' in outcome) throw outcome.error;
  if (releaseFailure) throw releaseFailure.error;
  const failed = settled.slice(0, extra.length).find((result) => result.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return outcome.value;
}

/**
 * 测试会话持住一把锁，期间执行 body（发请求、waitForBlocked、探针……）；退出时按 withRelease 的规则无条件放锁。
 * 否则持锁事务不结束，afterAll 的 handle.close() 会一直等它（vitest 60 秒钩子超时）并留下测试库。
 */
export async function withHeldLock<T>(spec: HeldLockSpec, body: (lock: HeldLockHandle) => Promise<T>): Promise<T> {
  let open!: () => void;
  let held!: () => void;
  const hold = new Promise<void>((done) => (open = done));
  const locked = new Promise<void>((done) => (held = done));
  const holder = spec.run(async (tx) => {
    await spec.take(tx);
    held();
    await hold;
    await spec.afterRelease?.(tx);
  });
  let releasing: Promise<void> | undefined;
  const release = () => {
    open();
    releasing ??= holder.then(() => undefined);
    return releasing;
  };
  return withRelease(
    release,
    async (lock) => {
      await Promise.race([locked, holder]);
      return body({ ...lock, release });
    },
    [holder],
  );
}

export interface QueueOptions {
  /** 第 index 个请求发出后应有几个会话在等锁；默认 index + 1。失败路径回归注入不符的人数。 */
  blockedAfter?: (index: number) => number;
  /** 单次等待上限（毫秒）。 */
  waitMs?: number;
}

/**
 * 先后启动的请求排在同一把锁后面：第 n 个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁；
 * 返回各请求的结果（allSettled）。持锁事务由 withHeldLock 收束（F-282）。
 */
export async function queueBehind(
  spec: HeldLockSpec,
  db: Db,
  requests: readonly (() => Promise<unknown>)[],
  options: QueueOptions = {},
) {
  const { blockedAfter = (index: number) => index + 1, waitMs } = options;
  const running = await withHeldLock(spec, async (session) => {
    const started: Promise<unknown>[] = [];
    for (const [index, request] of requests.entries()) {
      started.push(session.track(request()));
      await waitForBlocked(db, blockedAfter(index), waitMs);
    }
    return started;
  });
  return Promise.allSettled(running);
}
