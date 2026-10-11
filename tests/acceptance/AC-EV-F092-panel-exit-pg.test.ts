/** AC-EV-F092：真实 PostgreSQL 行锁交错；验证离职与组编辑两种先后顺序，避免成员被旧表单加回。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitWorld, rowsOf, type ExitWorld } from './AC-EV-F092-support.js';
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
    lockEmploymentBusiness: async (...args: Parameters<typeof original.lockEmploymentBusiness>) => {
      // 删除通过同文件内的 lockEmploymentBusiness 调员工锁，须在外层入口设屏障。
      if (args[1].commandId === barrier.beforeKey) {
        barrier.beforeReached?.();
        await barrier.beforeRelease;
      }
      return original.lockEmploymentBusiness(...args);
    },
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

/** 真实持有指定行锁，观察 HTTP / 消费者等待后才跨午夜，不能只用 mock 代替锁冲突。 */
async function crossMidnight<T>(
  w: ExitWorld,
  table: 'employment_employees' | 'ev_review_groups',
  id: string,
  action: () => Promise<T>,
  midnight = '2026-10-10T16:00:00Z',
): Promise<T> {
  const held = signal();
  const release = signal();
  const blocker = withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`SELECT id FROM ${sql.identifier(table)}
      WHERE tenant_id=${w.tenant.id} AND id=${id}::uuid FOR UPDATE`);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  let finished = false;
  const writing = action().finally(() => {
    finished = true;
  });
  try {
    await waitsForLock(w.db, () => finished);
    w.setTime(midnight);
  } finally {
    release.resolve();
    await Promise.all([blocker, writing]);
  }
  return writing;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EV-F092 第三轮锁后日期与原组编辑', () => {
  it.each(['employment_employees', 'ev_review_groups'] as const)(
    'AC-EV-F092 R3-P2-1 撤销离职跨午夜等待 %s：退组、版本、审计和队列同事务完成',
    async (table) => {
      const w = await exitWorld(database().db);
      w.setTime('2026-10-10T15:59:59Z');
      const person = await w.hire('跨午夜撤销评委', w.orgA);
      const g = await w.createGroup([person]);
      const leave = await w.savedLeave(person, '2026-10-10');
      const response = await crossMidnight(w, table, table === 'ev_review_groups' ? g.id : person.id, () =>
        w.undo(leave.id, leave.revision),
      );
      expect(response.status).toBe(200);
      await w.expectMembers(g.id, []);
      expect((await w.group(g.id)).revision).toBe(g.revision + 1);
      expect(await w.queue(leave.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
      expect(await w.audits(g.id)).toHaveLength(1);
      expect((await w.employee(person.id)).status).toBe('employed');
      const fresh = await w.createGroup([person]);
      expect(await w.run()).toMatchObject({ picked: 0 });
      await w.expectMembers(fresh.id, [person]);
    },
  );

  it('AC-EV-F092 R3-P2-1 删除次日重聘：请求跨午夜后先合法入组，再取得员工锁仍须补退', async () => {
    const w = await exitWorld(database().db);
    w.setTime('2026-10-10T15:59:59Z');
    const person = await w.hire('跨午夜删除重聘评委', w.orgA);
    const old = await w.createGroup([person]);
    const leave = await w.savedLeave(person, '2026-10-10');
    const rehire = await w.rehire(person, '2026-10-11');
    const reached = signal();
    const allowLock = signal();
    barrier.beforeKey = randomUUID();
    barrier.employeeId = person.id;
    barrier.beforeReached = reached.resolve;
    barrier.beforeRelease = allowLock.promise;
    const deleting = w.request('DELETE', `/api/tenant/employment/businesses/${rehire.id}`, {
      ifMatch: rehire.revision,
      idempotencyKey: barrier.beforeKey,
    });
    await Promise.race([
      reached.promise,
      deleting.then(() => {
        throw new Error('删除未到达业务锁入口');
      }),
    ]);
    w.setTime('2026-10-10T16:00:00Z');
    try {
      const fresh = await w.createGroup([person]);
      expect(await w.queue(leave.id)).toMatchObject([{ state: 'done' }]);
      await crossMidnight(w, 'employment_employees', person.id, () => {
        allowLock.resolve();
        return deleting;
      });
      expect((await deleting).status).toBe(200);
      expect((await w.employee(person.id)).status).toBe('left');
      await w.expectMembers(fresh.id, []);
      expect((await w.group(fresh.id)).revision).toBe(fresh.revision + 1);
      expect(await w.audits(fresh.id)).toHaveLength(1);
      await w.expectMembers(old.id, []);
      expect(await w.audits(old.id)).toHaveLength(1);
      expect(await w.run()).toMatchObject({ picked: 0 });
    } finally {
      allowLock.resolve();
      await deleting;
      barrier.beforeKey = '';
    }
  });

  it.each(['employment_employees', 'ev_review_groups'] as const)(
    'AC-EV-F092 R3-同类出口 离职落地跨午夜等待 %s：当场退组，不留到消费者补救',
    async (table) => {
      const w = await exitWorld(database().db);
      w.setTime('2026-10-10T15:59:59Z');
      const person = await w.hire('跨午夜落地评委', w.orgA);
      const g = await w.createGroup([person]);
      const response = await crossMidnight(w, table, table === 'ev_review_groups' ? g.id : person.id, () =>
        w.leave(person, '2026-10-10'),
      );
      expect(response.status).toBe(201);
      await w.expectMembers(g.id, []);
      expect((await w.group(g.id)).revision).toBe(g.revision + 1);
      expect(await w.audits(g.id)).toHaveLength(1);
      expect(await w.run()).toMatchObject({ picked: 0 });
    },
  );

  it.each(['pending', 'failed'])(
    'AC-EV-F092 R3-P2-2 原组保留重聘员工并新增成员（%s）：承接自身退组版本，重放无副作用',
    async (state) => {
      const w = await exitWorld(database().db);
      const person = await w.hire('原组重聘评委', w.orgA);
      const added = await w.hire('原组新增评委', w.orgB);
      const g = await w.createGroup([person]);
      const leave = await w.savedLeave(person, '2026-10-11');
      w.setTime('2026-10-12T16:00:00Z');
      await w.rehire(person, '2026-10-13');
      if (state === 'failed')
        await w.db.execute(sql`UPDATE ev_sync_queue SET state='failed', attempts=1,
        next_attempt_at='2026-10-14T00:00:00Z'::timestamptz
        WHERE tenant_id=${w.tenant.id} AND handler='review_group_exit' AND record_id=${leave.id}::uuid`);
      const key = randomUUID();
      const body = { members: w.members(person, added) };
      const response = await w.edit(g, body, key);
      expect(response.status).toBe(200);
      await w.expectMembers(g.id, [person, added]);
      expect((await w.group(g.id)).revision).toBe(g.revision + 2);
      expect(await w.queue(leave.id)).toMatchObject([{ state: 'done', attempts: state === 'failed' ? 2 : 1 }]);
      const audits = await w.audits(g.id);
      expect(audits).toHaveLength(2);
      expect(audits.find((a) => a.after.revision === g.revision + 1)).toMatchObject({
        commandId: key,
        before: { members: [{ employeeId: person.id }] },
        after: { members: [] },
      });
      expect(audits.find((a) => a.after.revision === g.revision + 2)).toMatchObject({
        commandId: key,
        before: { members: [] },
        after: { members: body.members },
      });
      expect((await w.edit(g, body, key)).status).toBe(200);
      expect(await w.audits(g.id)).toHaveLength(2);
      expect((await w.edit(g, body)).status).toBe(409);
      w.setTime('2026-10-14T00:00:00Z');
      expect(await w.run()).toMatchObject({ picked: 0 });
      await w.expectMembers(g.id, [person, added]);
    },
  );
  it.each(['新建', '编辑'])(
    'AC-EV-F092 R3-同类出口 %s等待旧组锁跨午夜：先结清旧周期，合法重聘成员仍可入组',
    async (mode) => {
      const w = await exitWorld(database().db);
      w.setTime('2026-10-10T15:59:59Z');
      const person = await w.hire('组锁跨午夜重聘评委', w.orgA);
      const old = await w.createGroup([person]);
      const target = mode === '编辑' ? await w.createGroup([]) : undefined;
      const leave = await w.savedLeave(person, '2026-10-10');
      await w.rehire(person, '2026-10-11');
      const result = await crossMidnight(w, 'ev_review_groups', old.id, async () => {
        if (!target) return w.createGroup([person]);
        const response = await w.edit(target, { members: w.members(person) });
        expect(response.status).toBe(200);
        return w.group(target.id);
      });
      await w.expectMembers(old.id, []);
      expect(await w.audits(old.id)).toHaveLength(1);
      expect(await w.queue(leave.id)).toMatchObject([{ state: 'done', attempts: 1 }]);
      await w.expectMembers(result.id, [person]);
      expect(await w.run()).toMatchObject({ picked: 0 });
    },
  );

  it.each(['employment_employees', 'ev_review_groups'] as const)(
    'AC-EV-F092 R3-同类出口 消费者等待 %s跨午夜：退组与队列使用锁后同一时刻',
    async (table) => {
      const w = await exitWorld(database().db);
      const person = await w.hire('消费者锁后时间评委', w.orgA);
      const g = await w.createGroup([person]);
      const leave = await w.savedLeave(person, '2026-10-11');
      w.setTime('2026-10-12T15:59:59Z');
      expect(
        await crossMidnight(
          w,
          table,
          table === 'ev_review_groups' ? g.id : person.id,
          () => w.run(),
          '2026-10-12T16:00:00Z',
        ),
      ).toMatchObject({ done: 1 });
      await w.expectMembers(g.id, []);
      const [row] = rowsOf<{ groupAt: string; queueAt: string }>(
        await w.db.execute(sql`
        SELECT g.updated_at::text AS "groupAt", q.updated_at::text AS "queueAt"
        FROM ev_review_groups g JOIN ev_sync_queue q ON q.tenant_id=g.tenant_id
        WHERE g.id=${g.id}::uuid AND q.handler='review_group_exit' AND q.record_id=${leave.id}::uuid`),
      );
      expect(new Date(row!.groupAt).toISOString()).toBe('2026-10-12T16:00:00.000Z');
      expect(row!.queueAt).toBe(row!.groupAt);
      expect(await w.audits(g.id)).toHaveLength(1);
    },
  );

  it('AC-EV-F092 R3-回归 原组编辑新增校验失败：旧退出、成员、版本、审计和队列全部回滚', async () => {
    const w = await exitWorld(database().db);
    const person = await w.hire('原组回滚重聘评委', w.orgA);
    const invalid = await w.hire('原组不能新增评委', w.orgA);
    const g = await w.createGroup([person]);
    const leave = await w.savedLeave(person, '2026-10-11');
    await w.savedLeave(invalid, '2026-10-10');
    w.setTime('2026-10-12T16:00:00Z');
    await w.rehire(person, '2026-10-13');
    const response = await w.edit(g, { members: w.members(person, invalid) });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).reason).toBe('REVIEW_GROUP_MEMBER_NOT_EMPLOYED');
    expect(await w.group(g.id)).toEqual(g);
    expect(await w.queue(leave.id)).toMatchObject([{ state: 'pending', attempts: 0 }]);
    expect(await w.audits(g.id)).toHaveLength(0);
  });

  it('AC-EV-F092 R3-回归 不同员工并发结清共享的多个旧组：统一组锁顺序，不丢成员或重复审计', async () => {
    const w = await exitWorld(database().db);
    const a = await w.hire('共享旧组评委甲', w.orgA);
    const b = await w.hire('共享旧组评委乙', w.orgA);
    const groups = [await w.createGroup([a, b]), await w.createGroup([b, a])];
    await w.savedLeave(a, '2026-10-11');
    await w.savedLeave(b, '2026-10-11');
    w.setTime('2026-10-12T16:00:00Z');
    await w.rehire(a, '2026-10-13');
    await w.rehire(b, '2026-10-13');
    const held = signal();
    const release = signal();
    const blocker = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM ev_review_groups WHERE tenant_id=${w.tenant.id}
        ORDER BY id FOR UPDATE`);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const saves = [w.createGroup([a]), w.createGroup([b])];
    try {
      const deadline = Date.now() + 8000;
      for (;;) {
        const [row] = rowsOf<{ n: number }>(
          await w.db.execute(sql`SELECT count(*)::int AS n
          FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`),
        );
        if (row!.n >= 2) break;
        if (Date.now() >= deadline) throw new Error('两个请求未同时等待共享组锁');
        await new Promise((done) => setTimeout(done, 10));
      }
    } finally {
      release.resolve();
      await Promise.all([blocker, ...saves]);
    }
    const fresh = await Promise.all(saves);
    for (const g of groups) {
      await w.expectMembers(g.id, []);
      expect((await w.group(g.id)).revision).toBe(g.revision + 2);
      expect(await w.audits(g.id)).toHaveLength(2);
    }
    await w.expectMembers(fresh[0]!.id, [a]);
    await w.expectMembers(fresh[1]!.id, [b]);
    expect(await w.run()).toMatchObject({ picked: 0 });
  });
});
