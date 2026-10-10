/**
 * AC-QL-sync 真 PostgreSQL 交错（设计 §7.4 ⑤；拆分方案 §5 C1-4）。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * - 迟提交事件：T1 先登记（时间戳更早）却后提交，T2 后登记先提交并被消费；T1 提交后下一轮仍被处理——消费者没有时间游标；
 * - 删除 × 同步：员工锁串行，处理器先持锁则子集按处理时的记录写下、删除随后成功；删除先提交则复核 gone、skipped；
 * - 两个调度器同时跑：FOR UPDATE SKIP LOCKED，每行只被一个处理，子集不重复。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { qualificationSyncProbe } from '../../apps/api/src/modules/qualification/sync-worker.js';
import { insertEmploymentRow, lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { removeEmploymentTimeline } from '../../apps/api/src/modules/employment/timeline.js';
import { syncWorld, rowsOf } from './AC-QL-sync-support.js';

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

async function configured(label: string) {
  const w = await syncWorld(database().db, label);
  const sequenceId = await w.sequence('同步序列');
  const jobLevelId = await w.jobLevel();
  await w.category({ type: 'sequence', jobObjectId: sequenceId });
  await w.level({ type: 'level', jobObjectId: jobLevelId });
  await w.settleBaseline();
  await w.enableSync(true);
  return { w, fields: { sequenceId, levelId: jobLevelId } };
}

/** 持员工锁的事务：放行前，对同一员工的任职写入会真实等待。 */
function holdEmployeeLock(w: Awaited<ReturnType<typeof configured>>['w'], employeeId: string) {
  const held = signal();
  const release = signal();
  const done = withTenant(w.db, w.tenantId, async (tx) => {
    await lockEmploymentEmployee(tx, w.context('2026-10-10T01:00:00Z'), employeeId);
    held.resolve();
    await release.promise;
  });
  return { held: held.promise, release: release.resolve, done };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-QL-sync 真 PG：迟提交事件与并发', () => {
  it('迟提交事件：T1 时间戳更早却后提交，T2 先提交并已被消费；T1 提交后下一轮仍被处理（设计 §7.4 ⑤）', async () => {
    const { w, fields } = await configured('qlsync-pg-late');
    const other = await w.session.employee('迟提交对照员工');
    const hire = await w.session.business(
      other.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.from.id } },
      other.revision,
    );
    await w.run('2026-10-10T05:00:00Z');
    const locker = holdEmployeeLock(w, w.subject.employee.id);
    await locker.held;

    // T1：时钟 10:00 时发出，被员工锁挡住，事件稍后才写入并提交
    w.session.setNow('2026-10-10T02:00:00Z');
    let t1Finished = false;
    const t1 = w.transferWith('2026-10-05', fields).then((id) => {
      t1Finished = true;
      return id;
    });
    await waitForLock(w.db, () => t1Finished);

    // T2：时钟更晚，另一名员工的调动先提交、先被消费
    w.session.setNow('2026-10-10T03:00:00Z');
    const t2 = await w.transferWith('2026-10-06', fields, other.id);
    expect(hire.id).toBeTruthy();
    await w.run('2026-10-10T05:00:00Z');
    expect(await w.queue(t2)).toMatchObject([{ state: 'done' }]);

    locker.release();
    await locker.done;
    const t1Record = await t1;
    // T1 的事件创建时间早于已被消费的 T2：时间游标会越过它，状态队列不会
    expect(await w.queue(t1Record)).toMatchObject([{ state: 'pending' }]);
    await w.run('2026-10-10T06:00:00Z');
    expect(await w.queue(t1Record)).toMatchObject([{ state: 'done' }]);
    expect(await w.subsets()).toMatchObject([{ employmentRecordId: t1Record }]);
  });

  it('处理器先持员工锁：删除在锁上等待，处理器按处理时的记录写下子集，随后删除成功（设计 §7.4）', async () => {
    const { w, fields } = await configured('qlsync-pg-sync-first');
    const recordId = await w.transferWith('2026-10-05', fields);
    const rechecked = signal();
    const release = signal();
    qualificationSyncProbe.afterRecheck = async () => {
      rechecked.resolve();
      await release.promise;
    };
    try {
      const worker = w.run('2026-10-10T05:00:00Z');
      await rechecked.promise;
      const revision = (await w.business(recordId)).revision;
      let deleted = false;
      const deletion = w.session
        .request('DELETE', `/businesses/${recordId}`, { ifMatch: revision })
        .then((response) => {
          deleted = true;
          return response;
        });
      await waitForLock(w.db, () => deleted);
      release.resolve();
      expect(await worker).toMatchObject({ done: 1 });
      expect((await deletion).status).toBe(200);
      expect(await w.queue(recordId)).toMatchObject([{ state: 'done' }]);
      expect(await w.subsets()).toMatchObject([{ employmentRecordId: recordId }]);
    } finally {
      qualificationSyncProbe.afterRecheck = undefined;
    }
  });

  it('删除先提交：处理器在员工锁上等待，放行后复核 gone → skipped，不写子集（设计 §7.4）', async () => {
    const { w, fields } = await configured('qlsync-pg-delete-first');
    const recordId = await w.transferWith('2026-10-05', fields);
    const held = signal();
    const release = signal();
    // 删除命令在员工锁内的数据变更：墓碑 + 摘掉时间轴（与 transitions.ts 的 deleteEmploymentBusiness 同序）
    const deleter = withTenant(w.db, w.tenantId, async (tx) => {
      const ctx = w.context('2026-10-10T01:00:00Z');
      await lockEmploymentEmployee(tx, ctx, w.subject.employee.id);
      held.resolve();
      await release.promise;
      await insertEmploymentRow(tx, 'employment_record_tombstones', {
        id: randomUUID(),
        tenantId: w.tenantId,
        employeeId: w.subject.employee.id,
        recordId,
        commandId: ctx.commandId,
        createdAt: ctx.now.toISOString(),
      });
      await removeEmploymentTimeline(tx, ctx, w.subject.employee.id, recordId, false);
    });
    await held.promise;
    let finished = false;
    const worker = w.run('2026-10-10T05:00:00Z').then((result) => {
      finished = true;
      return result;
    });
    await waitForLock(w.db, () => finished);
    release.resolve();
    await deleter;
    expect(await worker).toMatchObject({ skipped: 1, done: 0 });
    expect(await w.queue(recordId)).toMatchObject([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await w.subsets()).toEqual([]);
  });

  it('两个调度器同时跑：每行只被一个处理（SKIP LOCKED），子集不重复（设计 §4.3）', async () => {
    const { w, fields } = await configured('qlsync-pg-two-runners');
    const recordIds: string[] = [];
    for (const date of ['2026-10-02', '2026-10-03', '2026-10-04']) recordIds.push(await w.transferWith(date, fields));
    const [a, b] = await Promise.all([w.run('2026-10-10T05:00:00Z'), w.run('2026-10-10T05:00:00Z')]);
    expect(a.done + b.done).toBe(3);
    for (const id of recordIds) expect(await w.queue(id)).toMatchObject([{ state: 'done', attempts: 1 }]);
    expect(await w.subsets()).toHaveLength(3);
  });
});
