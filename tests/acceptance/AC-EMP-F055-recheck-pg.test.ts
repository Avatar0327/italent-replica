/**
 * F-055（R3-T02 拆分方案 §10.3，真 PostgreSQL）：删除 / 改期 × 消费者“持员工锁 → 复核 → 写派生数据”交错。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。两种先后顺序都覆盖：
 * - 写入方先持锁：消费者取数后在员工锁上真实等待，提交后按新状态复核；
 * - 消费者先持锁：删除 / 改期在锁上真实等待，消费者提交后才继续，派生数据按消费时的状态写下。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { insertEmploymentRow, lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { removeEmploymentTimeline } from '../../apps/api/src/modules/employment/timeline.js';
import {
  f055World,
  installProbeQueue,
  probeBaseline,
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
  await probeBaseline(w.db, w.tenantId);
  return w;
}

/** 删除命令在员工锁内的数据变更：墓碑 + 摘掉时间轴（与 transitions.ts 的 deleteEmploymentBusiness 同序）。 */
async function deleteInTx(w: F055World, tx: Tx, recordId: string) {
  const ctx = w.context('2026-10-10T01:00:00Z');
  await insertEmploymentRow(tx, 'employment_record_tombstones', {
    id: randomUUID(),
    tenantId: w.tenantId,
    employeeId: w.subject.employee.id,
    recordId,
    commandId: ctx.commandId,
    createdAt: ctx.now.toISOString(),
  });
  await removeEmploymentTimeline(tx, ctx, w.subject.employee.id, recordId, false);
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

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EMP-F055 真 PG：删除 × 消费交错', () => {
  it('删除先提交：消费者取数后在员工锁上等待，放行后复核 gone → skipped，不写派生数据', async () => {
    const w = await setup('f055-pg-delete-first');
    const id = await w.transfer('2026-10-01');
    await probeEnqueue(w.db, w.tenantId);
    const deleter = holdLockThen(w, async (tx) => {
      await deleteInTx(w, tx, id);
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
    await probeEnqueue(w.db, w.tenantId);
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

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EMP-F055 真 PG：改期（删除后以新日期重存）× 消费交错', () => {
  it('改期先提交：消费者取数后在员工锁上等待，旧事件复核 gone；新事件 not_yet，到新日期才处理', async () => {
    const w = await setup('f055-pg-move-first');
    const old = await w.transfer('2026-10-01');
    await probeEnqueue(w.db, w.tenantId);
    const deleter = holdLockThen(w, async (tx) => {
      await deleteInTx(w, tx, old);
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
    await consumer;
    expect(await probeState(w.db, w.tenantId, old)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    const moved = await w.transfer('2026-10-30');
    await probeEnqueue(w.db, w.tenantId);
    await probeRound(w.db, w.context('2026-10-29T01:00:00Z'));
    expect(await probeState(w.db, w.tenantId, moved)).toEqual([{ state: 'pending', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, moved)).toEqual([]);
    await probeRound(w.db, w.context('2026-10-30T01:00:00Z'));
    expect(await probeDerived(w.db, w.tenantId, moved)).toEqual([{ effectiveDate: '2026-10-30' }]);
  });

  it('消费者先提交：改期的删除在员工锁上等待，消费者提交后改期照常落地；新事件按新日期单独处理', async () => {
    const w = await setup('f055-pg-consume-then-move');
    const old = await w.transfer('2026-10-01');
    await probeEnqueue(w.db, w.tenantId);
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
    const moving = w.reschedule(old, '2026-10-30').then((id) => {
      finished = true;
      return id;
    });
    await waitForLock(w.db, () => finished);
    release.resolve();
    await consumer;
    const moved = await moving;
    expect(await probeState(w.db, w.tenantId, old)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, old)).toEqual([{ effectiveDate: '2026-10-01' }]);
    expect(await w.recheck(old, '2026-10-10')).toEqual({ kind: 'gone', reason: 'RECORD_NOT_EFFECTIVE' });
    expect(await w.recheck(moved, '2026-10-10')).toEqual({ kind: 'not_yet', effectiveDate: '2026-10-30' });
    await probeEnqueue(w.db, w.tenantId);
    await probeRound(w.db, w.context('2026-10-30T01:00:00Z'));
    expect(await probeDerived(w.db, w.tenantId, moved)).toEqual([{ effectiveDate: '2026-10-30' }]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EMP-F055 真 PG：同 ID 顺延 × 消费交错', () => {
  const consumerClock = '2026-10-09T01:00:00Z';
  const postponeClock = '2026-10-10T01:00:00Z';

  it('顺延先提交：消费者（按 10-09 判断）取数后在员工锁上等待，放行后复核 not_yet → 退回 pending，不写派生数据', async () => {
    const w = await setup('f055-pg-postpone-first');
    const id = await w.transfer('2026-10-05');
    await probeEnqueue(w.db, w.tenantId);
    const mover = holdLockThen(w, (tx) => w.postponeIn(tx, id, postponeClock));
    await mover.held;
    let consumed = false;
    const consumer = probeRound(w.db, w.context(consumerClock)).then((picked) => {
      consumed = true;
      return picked;
    });
    await waitForLock(w.db, () => consumed);
    mover.release();
    await mover.done;
    expect((await consumer).map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'pending', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    await probeRound(w.db, w.context(postponeClock));
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-10' }]);
  });

  it('消费者先提交：顺延在员工锁上等待，消费者提交后顺延照常落地；派生数据按消费时的日期保留', async () => {
    const w = await setup('f055-pg-consume-then-postpone');
    const id = await w.transfer('2026-10-05');
    await probeEnqueue(w.db, w.tenantId);
    const rechecked = signal();
    const release = signal();
    const consumer = probeRound(w.db, w.context(consumerClock), {
      afterRecheck: async () => {
        rechecked.resolve();
        await release.promise;
      },
    });
    await rechecked.promise;
    let finished = false;
    const moving = w.postpone(id, postponeClock).then(() => {
      finished = true;
    });
    await waitForLock(w.db, () => finished);
    release.resolve();
    await consumer;
    await moving;
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-05' }]);
    expect(await w.recheck(id, '2026-10-09')).toEqual({ kind: 'not_yet', effectiveDate: '2026-10-10' });
  });
});
