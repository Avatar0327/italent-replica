/** AC-EV-F092：真实 PostgreSQL 行锁交错；验证离职与组编辑两种先后顺序，避免成员被旧表单加回。 */
import { randomUUID } from 'node:crypto';
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitWorld, rowsOf } from './AC-EV-F092-support.js';
import { errorOf } from './AC-EV-support.js';
import type * as EmploymentStore from '../../apps/api/src/modules/employment/record-store.js';

const barrier = vi.hoisted(() => ({
  key: '',
  employeeId: '',
  reached: undefined as undefined | (() => void),
  release: undefined as undefined | Promise<void>,
  beforeKey: '',
  beforeReached: undefined as undefined | (() => void),
  beforeRelease: undefined as undefined | Promise<void>,
}));
vi.mock('../../apps/api/src/modules/employment/record-store.js', async (load) => {
  const original = await load<typeof EmploymentStore>();
  return {
    ...original,
    lockEmploymentEmployee: async (...args: Parameters<typeof original.lockEmploymentEmployee>) => {
      if (args[1].commandId === barrier.beforeKey && args[2] === barrier.employeeId) {
        barrier.beforeReached?.();
        await barrier.beforeRelease;
      }
      const result = await original.lockEmploymentEmployee(...args);
      if (args[1].commandId === barrier.key && args[2] === barrier.employeeId) {
        barrier.reached?.();
        await barrier.release;
      }
      return result;
    },
  };
});

const database = useTestDb();
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitsForLock(db: Db, finished: () => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (finished()) throw new Error('第二个请求未真实等待 PostgreSQL 行锁');
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('未观测到 PostgreSQL 行锁等待');
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EV-F092 真 PG：离职 × 评审组编辑', () => {
  afterEach(() => {
    barrier.key = '';
    barrier.employeeId = '';
    barrier.reached = undefined;
    barrier.release = undefined;
    barrier.beforeKey = '';
    barrier.beforeReached = undefined;
    barrier.beforeRelease = undefined;
  });

  it('AC-EV-F092 离职先持员工锁：编辑真实等待，离职提交后旧 revision 返回 409、不能加回', async () => {
    const w = await exitWorld(database().db);
    const leaving = await w.hire('并发离职先行评委', w.orgA);
    const kept = await w.hire('并发离职留任评委', w.orgA);
    const g = await w.createGroup([leaving, kept]);
    const paused = signal();
    const release = signal();
    barrier.key = randomUUID();
    barrier.employeeId = leaving.id;
    barrier.reached = paused.resolve;
    barrier.release = release.promise;
    const leave = w.leave(leaving, '2026-10-10', barrier.key);
    await paused.promise;
    let finished = false;
    const edit = w.edit(g, { members: w.members(leaving, kept) }).then((r) => {
      finished = true;
      return r;
    });
    try {
      await waitsForLock(w.db, () => finished);
    } finally {
      release.resolve();
      await Promise.all([leave, edit]);
    }
    expect((await leave).status).toBe(201);
    expect((await edit).status).toBe(409);
    await w.expectMembers(g.id, [kept]);
    expect(await w.audits(g.id)).toHaveLength(1);
  });

  it('AC-EV-F092 编辑先持员工锁：离职真实等待，编辑成功后离职移出所有组且保留新成员', async () => {
    const w = await exitWorld(database().db);
    const leaving = await w.hire('并发编辑先行评委', w.orgA);
    const added = await w.hire('并发新增评委', w.orgB);
    const g = await w.createGroup([leaving]);
    const paused = signal();
    const release = signal();
    barrier.key = randomUUID();
    barrier.employeeId = leaving.id;
    barrier.reached = paused.resolve;
    barrier.release = release.promise;
    const edit = w.edit(g, { members: w.members(leaving, added) }, barrier.key);
    // 旧实现不取员工锁，所以编辑返回会使红测立刻报错，不能无限等待探针。
    await Promise.race([
      paused.promise,
      edit.then(() => {
        throw new Error('编辑没有先锁成员员工行');
      }),
    ]);
    let finished = false;
    const leave = w.leave(leaving, '2026-10-10').then((r) => {
      finished = true;
      return r;
    });
    try {
      await waitsForLock(w.db, () => finished);
    } finally {
      release.resolve();
      await Promise.all([leave, edit]);
    }
    expect((await edit).status).toBe(200);
    expect((await leave).status).toBe(201);
    await w.expectMembers(g.id, [added]);
    expect((await w.group(g.id)).revision).toBe(g.revision + 2);
    expect(await w.audits(g.id)).toHaveLength(2);
  });

  it('AC-EV-F092 两个到期消费者真实交错：第二个等员工锁，同一队列只退组和写审计一次', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('并发消费者评委', w.orgA);
    const g = await w.createGroup([person]);
    const record = await w.savedLeave(person, '2026-10-11');
    const [row] = rowsOf<{ id: string }>(
      await w.db.execute(sql`SELECT id FROM ev_sync_queue
      WHERE tenant_id=${w.tenant.id} AND handler='review_group_exit' AND record_id=${record.id}::uuid`),
    );
    const paused = signal();
    const release = signal();
    barrier.key = `review-group-exit:${row!.id}`;
    barrier.employeeId = person.id;
    barrier.reached = paused.resolve;
    barrier.release = release.promise;
    w.setTime('2026-10-11T16:00:00Z');
    const first = w.run();
    await paused.promise;
    let finished = false;
    const second = w.run().then((result) => {
      finished = true;
      return result;
    });
    try {
      await waitsForLock(w.db, () => finished);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    const results = await Promise.all([first, second]);
    expect(results.reduce((total, result) => total + result.done, 0)).toBe(1);
    await w.expectMembers(g.id, []);
    expect((await w.group(g.id)).revision).toBe(g.revision + 1);
    expect(await w.queue(record.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
    expect(await w.audits(g.id)).toHaveLength(1);
  });

  it.each(['新建', '编辑新增'])(
    'AC-EV-F092 P2-3 %s跨午夜等员工锁：消费者先退组，锁后按新业务日拒绝离职员工',
    async (mode) => {
      const w = await exitWorld(database().db);
      w.setTime('2026-10-10T15:59:59Z');
      const person = await w.hire('跨午夜等待评委', w.orgA);
      const g = mode === '编辑新增' ? await w.createGroup([]) : undefined;
      const leave = await w.savedLeave(person, '2026-10-10');
      const [queue] = rowsOf<{ id: string }>(
        await w.db.execute(sql`SELECT id FROM ev_sync_queue
      WHERE tenant_id=${w.tenant.id} AND handler='review_group_exit' AND record_id=${leave.id}::uuid`),
      );
      const writingReady = signal();
      const allowWriteLock = signal();
      const workerReady = signal();
      const allowWorkerFinish = signal();
      barrier.beforeKey = randomUUID();
      barrier.employeeId = person.id;
      barrier.beforeReached = writingReady.resolve;
      barrier.beforeRelease = allowWriteLock.promise;
      barrier.key = `review-group-exit:${queue!.id}`;
      barrier.reached = workerReady.resolve;
      barrier.release = allowWorkerFinish.promise;
      let finished = false;
      const writing = w
        .request(g ? 'PATCH' : 'POST', `/api/tenant/evaluation/review-groups${g ? `/${g.id}` : ''}`, {
          ifMatch: g?.revision ?? 0,
          idempotencyKey: barrier.beforeKey,
          body: { ...(g ? {} : { name: '跨午夜新组', ownerOrgId: w.orgA }), members: w.members(person) },
        })
        .then((response) => {
          finished = true;
          return response;
        });
      await Promise.race([
        writingReady.promise,
        writing.then(() => {
          throw new Error('保存未到达员工锁');
        }),
      ]);
      w.setTime('2026-10-10T16:00:00Z');
      const worker = w.run();
      try {
        await workerReady.promise;
        allowWriteLock.resolve();
        await waitsForLock(w.db, () => finished);
      } finally {
        allowWriteLock.resolve();
        allowWorkerFinish.resolve();
        await Promise.all([worker, writing]);
      }
      const response = await writing;
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toEqual({
        code: 'VALIDATION_FAILED',
        reason: 'REVIEW_GROUP_MEMBER_NOT_EMPLOYED',
      });
      expect((await w.employee(person.id)).status).toBe('left');
      expect(await w.queue(leave.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
      expect(await w.run()).toMatchObject({ picked: 0 });
      if (g) expect(await w.group(g.id)).toEqual(g);
      const rows = rowsOf(await w.db.execute(sql`SELECT id FROM ev_review_groups WHERE tenant_id=${w.tenant.id}`));
      expect(rows).toHaveLength(g ? 1 : 0);
    },
  );
});
