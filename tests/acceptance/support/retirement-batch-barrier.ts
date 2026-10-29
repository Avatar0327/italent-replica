import { sql, type Db } from '@italent/db';
import { rows } from '../AC-RT-batch-support.js';

/** F-292：失败/超时后先放行所有暂停点，再等待后台任务退出，避免带锁事务拖挂后续用例。 */
export function batchBarriers() {
  const releases: (() => void)[] = [];
  const tasks: Promise<PromiseSettledResult<unknown>>[] = [];

  function gate() {
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const proceed = new Promise<void>((resolve) => (release = resolve));
    releases.push(release);
    return {
      reach,
      release,
      proceed,
      waitFor: (task: Promise<unknown>) =>
        Promise.race([
          reached,
          task.then(() => {
            throw new Error('批次在到达屏障前已结束');
          }),
        ]),
    };
  }

  function track<T>(task: Promise<T>): Promise<T> {
    // 立即登记拒绝处理器，清理时仍逐条报告错误，不把后台失败吞成成功。
    tasks.push(
      task.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason }),
      ),
    );
    return task;
  }

  async function close() {
    for (const release of releases.splice(0)) release();
    const results = await Promise.all(tasks.splice(0));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        '屏障后台任务失败',
      );
  }

  return { gate, track, close };
}

/** 只认真实接管 UPDATE 的锁等待；接管已完成或达到观察期限都返回 false，不以时间流逝证明阻塞。 */
export async function takeoverWaitsForOwner(db: Db, ownerPid: number, taker: Promise<unknown>) {
  let finished = false;
  void taker.then(
    () => (finished = true),
    () => (finished = true),
  );
  const deadline = Date.now() + 5_000;
  do {
    const blocked = rows<{ pid: number }>(
      await db.execute(sql`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock'
          AND query LIKE 'UPDATE retirement_rule_daily_runs SET lease_until=%'
          AND ${ownerPid}::int = ANY(pg_blocking_pids(pid))`),
    );
    if (blocked.length) return true;
  } while (!finished && Date.now() < deadline);
  return false;
}
