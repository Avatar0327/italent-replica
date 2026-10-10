/**
 * AC-QL-sync 真 PostgreSQL 交错（设计 §7.4 ⑤；拆分方案 §5 C1-4）。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * - 迟提交事件：T1 先登记（时间戳更早）却后提交，T2 后登记先提交并被消费；T1 提交后下一轮仍被处理——消费者没有时间游标；
 * - 删除 × 同步：员工锁串行，处理器先持锁则子集按处理时的记录写下、删除随后成功；删除先提交则复核 gone、skipped；
 * - 两个调度器同时跑：FOR UPDATE SKIP LOCKED，每行只被一个处理，子集不重复。
 */
import { randomUUID } from 'node:crypto';
import { createPgDb, sql, withTenant, type Db, type DbHandle, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { qualificationSyncProbe, runQualificationSync } from '../../apps/api/src/modules/qualification/sync-worker.js';
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
  const categoryId = await w.category({ type: 'sequence', jobObjectId: sequenceId });
  const levelId = await w.level({ type: 'level', jobObjectId: jobLevelId });
  await w.settleBaseline();
  await w.enableSync(true);
  return { w, categoryId, levelId, fields: { sequenceId, levelId: jobLevelId } };
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

/**
 * 被终止连接的消费者用独立的连接池：postgres.js 关闭含已断连接的池会挂起，不能拖垮测试库的 afterAll。
 * 池指向同一个测试库（库名取自当前会话）；用完限时关闭。
 */
async function withKillablePool<T>(db: Db, work: (killable: Db) => Promise<T>): Promise<T> {
  const [row] = rowsOf<{ name: string }>(await db.execute(sql`SELECT current_database() AS name`));
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${row!.name}`;
  const handle: DbHandle = createPgDb(url.toString(), { max: 2 });
  try {
    return await work(handle.db);
  } finally {
    await Promise.race([handle.close().catch(() => undefined), new Promise((done) => setTimeout(done, 3000))]);
  }
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

  // ---- 第 1 轮审查 P2-02：类别 / 级别停用与同步交错 ----------------------------------------------------------------
  async function disableInTx(
    w: Awaited<ReturnType<typeof configured>>['w'],
    table: 'ql_categories' | 'ql_levels',
    id: string,
  ) {
    const held = signal();
    const release = signal();
    const done = withTenant(w.db, w.tenantId, async (tx) => {
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET enabled=false WHERE tenant_id=${w.tenantId} AND id=${id}::uuid`,
      );
      held.resolve();
      await release.promise;
    });
    return { held: held.promise, release: release.resolve, done };
  }

  it.each([
    ['ql_categories' as const, '类别'],
    ['ql_levels' as const, '级别'],
  ])('%s 停用先于同步取数：同步在配置行上等待，放行后复核已停用 → 不生成子集（P2-02，AC-QL-sync）', async (table) => {
    const { w, fields, categoryId, levelId } = await configured(`qlsync-pg-disable-first-${table}`);
    const recordId = await w.transferWith('2026-10-05', fields);
    const disabling = await disableInTx(w, table, table === 'ql_categories' ? categoryId : levelId);
    await disabling.held;
    let finished = false;
    const worker = w.run('2026-10-10T05:00:00Z').then((result) => {
      finished = true;
      return result;
    });
    await waitForLock(w.db, () => finished);
    disabling.release();
    await disabling.done;
    await worker;
    expect(await w.subsets()).toEqual([]);
    expect(await w.queue(recordId)).toMatchObject([{ state: 'skipped', reason: 'NO_MAPPING' }]);
  });

  it.each([
    ['ql_categories' as const, '类别'],
    ['ql_levels' as const, '级别'],
  ])('%s 同步先取得配置行：停用在锁上等待，同步写入后停用才完成（P2-02，AC-QL-sync）', async (table) => {
    const { w, fields, categoryId, levelId } = await configured(`qlsync-pg-sync-first-${table}`);
    const recordId = await w.transferWith('2026-10-05', fields);
    const paused = signal();
    const release = signal();
    qualificationSyncProbe.beforeWrite = async () => {
      paused.resolve();
      await release.promise;
    };
    try {
      const worker = w.run('2026-10-10T05:00:00Z');
      await paused.promise;
      let disabled = false;
      const id = table === 'ql_categories' ? categoryId : levelId;
      const disabling = withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(
          sql`UPDATE ${sql.identifier(table)} SET enabled=false WHERE tenant_id=${w.tenantId} AND id=${id}::uuid`,
        ),
      ).then(() => {
        disabled = true;
      });
      await waitForLock(w.db, () => disabled);
      release.resolve();
      expect(await worker).toMatchObject({ done: 1 });
      await disabling;
      expect(await w.queue(recordId)).toMatchObject([{ state: 'done' }]);
      expect(await w.subsets()).toHaveLength(1);
    } finally {
      qualificationSyncProbe.beforeWrite = undefined;
    }
  });

  // ---- 第 1 轮审查 P2-03：连接故障要分类审计、记次数与原因 -------------------------------------------------------------
  async function killOwnBackend(db: Db, tx: Tx) {
    const [row] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
    await db.execute(sql`SELECT pg_terminate_backend(${row!.pid})`);
    await new Promise((done) => setTimeout(done, 50));
  }
  const failureAudits = (w: Awaited<ReturnType<typeof configured>>['w']) =>
    withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ outcome: string; errorCode: string }>(
        await tx.execute(sql`SELECT outcome, error_code AS "errorCode" FROM audit_command_failures
          WHERE tenant_id=${w.tenantId} ORDER BY occurred_at`),
      ),
    );

  it('执行阶段消费者的 PG 连接被终止：队列记 failed / 次数 / 原因，写存储不可写的失败审计，恢复后重试成功且不重复（P2-03，AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-pg-conn-exec');
    const recordId = await w.transferWith('2026-10-05', fields);
    qualificationSyncProbe.afterRecheck = (tx) => killOwnBackend(w.db, tx);
    try {
      const first = await withKillablePool(w.db, (killable) =>
        runQualificationSync(killable, w.tenantId, { clock: () => new Date('2026-10-10T05:00:00Z') }),
      );
      expect(first).toMatchObject({ failed: 1, done: 0 });
    } finally {
      qualificationSyncProbe.afterRecheck = undefined;
    }
    const [row] = await w.queue(recordId);
    expect(row).toMatchObject({ state: 'failed', attempts: 1 });
    expect(row!.reason).toBeTruthy();
    expect(new Date(row!.nextAttemptAt).getTime()).toBeGreaterThan(new Date('2026-10-10T05:00:00Z').getTime());
    expect(await failureAudits(w)).toMatchObject([{ outcome: 'storage_unwritable' }]);
    expect(await w.subsets()).toEqual([]);

    expect(await w.run('2026-10-10T07:00:00Z')).toMatchObject({ done: 1 });
    expect(await w.queue(recordId)).toMatchObject([{ state: 'done', attempts: 2 }]);
    expect(await w.subsets()).toHaveLength(1);
  });

  it('提交阶段连接被终止：按“结果未知”记失败审计，回查持久状态后记 failed，重试成功且不重复（P2-03，AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-pg-conn-commit');
    const recordId = await w.transferWith('2026-10-05', fields);
    qualificationSyncProbe.afterSettle = (tx) => killOwnBackend(w.db, tx);
    try {
      const first = await withKillablePool(w.db, (killable) =>
        runQualificationSync(killable, w.tenantId, { clock: () => new Date('2026-10-10T05:00:00Z') }),
      );
      expect(first).toMatchObject({ failed: 1, done: 0 });
    } finally {
      qualificationSyncProbe.afterSettle = undefined;
    }
    expect(await w.queue(recordId)).toMatchObject([{ state: 'failed', attempts: 1 }]);
    expect(await failureAudits(w)).toMatchObject([{ outcome: 'unknown' }]);
    expect(await w.subsets()).toEqual([]);

    expect(await w.run('2026-10-10T07:00:00Z')).toMatchObject({ done: 1 });
    expect(await w.subsets()).toHaveLength(1);
  });
});
