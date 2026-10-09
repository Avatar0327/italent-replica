/**
 * F-055（R3-T02 拆分方案 §10.3，真 PostgreSQL）：删除 / 改期 × 消费者“持员工锁 → 复核 → 写派生数据”交错。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。两种先后顺序都覆盖：
 * - 写入方先持锁：消费者取数后在员工锁上真实等待，提交后按新状态复核；
 * - 消费者先持锁：删除 / 改期在锁上真实等待，消费者提交后才继续，派生数据按消费时的状态写下。
 */
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { removeEmploymentTimeline } from '../../apps/api/src/modules/employment/timeline.js';
import {
  f055World,
  installProbeQueue,
  probeDerived,
  probeEnqueue,
  probeRound,
  probeState,
  rowsOf,
  type F055World,
} from './AC-EMP-F055-support.js';

const database = useTestDb();

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForLock(db: Db, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('第二个事务没有真实等待数据库锁');
    const [waiting] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (waiting!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到真实锁等待');
}

async function setup(label: string) {
  const w = await f055World(database().db, label);
  await installProbeQueue(w.db);
  await probeEnqueue(w.db, w.tenantId);
  return w;
}

/** 写入方：先持员工锁，等放行后执行写入并提交（等价于删除 / 改期命令在员工锁内的时间轴变更）。 */
function holdLockThen(w: F055World, mutate: (tx: Tx) => Promise<void>) {
  const held = signal();
  const release = signal();
  const done = withTenant(w.db, w.tenantId, async (tx) => {
    await lockEmploymentEmployee(tx, w.context('2026-10-10T01:00:00Z'), w.subject.employee.id);
    held.resolve();
    await release.promise;
    await mutate(tx);
  });
  return { held: held.promise, release: release.resolve, done };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('F-055 真 PG：删除 × 消费交错', () => {
  it('删除先提交：消费者取数后在员工锁上等待，放行后复核 gone → skipped，不写派生数据', async () => {
    const w = await setup('f055-pg-delete-first');
    const id = await w.transfer('2026-10-01');
    const deleter = holdLockThen(w, async (tx) => {
      await removeEmploymentTimeline(tx, w.context('2026-10-10T01:00:00Z'), w.subject.employee.id, id, false);
    });
    await deleter.held;
    let consumed = false;
    const consumer = probeRound(w.db, w.context('2026-10-10T01:00:00Z')).then((picked) => {
      consumed = true;
      return picked;
    });
    await waitForLock(w.db, () => consumed);
    deleter.release();
    await deleter.done;
    expect((await consumer).map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
  });

  it('消费者先提交：真实删除命令在员工锁上等待，消费者提交后删除照常成功，派生数据按消费时的状态保留', async () => {
    const w = await setup('f055-pg-consume-first');
    const id = await w.transfer('2026-10-01');
    const rechecked = signal();
    const release = signal();
    const consumer = probeRound(w.db, w.context('2026-10-10T01:00:00Z'), {
      afterRecheck: async () => {
        rechecked.resolve();
        await release.promise;
      },
    });
    await rechecked.promise;
    const revision = (await w.business(id)).revision;
    let finished = false;
    const deletion = w.session.request('DELETE', `/businesses/${id}`, { ifMatch: revision }).then((response) => {
      finished = true;
      return response;
    });
    await waitForLock(w.db, () => finished);
    release.resolve();
    await consumer;
    expect((await deletion).status).toBe(200);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-01' }]);
    expect(await w.recheck(id, '2026-10-10')).toEqual({ kind: 'gone', reason: 'RECORD_NOT_EFFECTIVE' });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('F-055 真 PG：改期 × 消费交错', () => {
  it('改期先提交（挪到未来）：消费者只按提交后的日期判断 → not_yet，回 pending，不写派生数据', async () => {
    const w = await setup('f055-pg-move-first');
    const id = await w.transfer('2026-10-01');
    const mover = holdLockThen(w, (tx) => w.moveTimelineIn(tx, id, '2026-10-30'));
    await mover.held;
    let consumed = false;
    const consumer = probeRound(w.db, w.context('2026-10-10T01:00:00Z')).then((picked) => {
      consumed = true;
      return picked;
    });
    await waitForLock(w.db, () => consumed);
    mover.release();
    await mover.done;
    expect((await consumer).map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'pending', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    // 新日期到了再处理
    await probeRound(w.db, w.context('2026-10-30T01:00:00Z'));
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-30' }]);
  });

  it('消费者先提交：改期在员工锁上等待，消费者提交后改期照常落地，派生数据按消费时的日期保留', async () => {
    const w = await setup('f055-pg-consume-then-move');
    const id = await w.transfer('2026-10-01');
    const rechecked = signal();
    const release = signal();
    const consumer = probeRound(w.db, w.context('2026-10-10T01:00:00Z'), {
      afterRecheck: async () => {
        rechecked.resolve();
        await release.promise;
      },
    });
    await rechecked.promise;
    let finished = false;
    const mover = withTenant(w.db, w.tenantId, async (tx) => {
      await lockEmploymentEmployee(tx, w.context('2026-10-10T01:00:00Z'), w.subject.employee.id);
      await w.moveTimelineIn(tx, id, '2026-10-30');
    }).then(() => {
      finished = true;
    });
    await waitForLock(w.db, () => finished);
    release.resolve();
    await consumer;
    await mover;
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-01' }]);
    expect(await w.recheck(id, '2026-10-10')).toEqual({ kind: 'not_yet', effectiveDate: '2026-10-30' });
  });
});
