/** AC-EV-F092：真实 PostgreSQL 行锁交错；验证离职与组编辑两种先后顺序，避免成员被旧表单加回。 */
import { randomUUID } from 'node:crypto';
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitWorld, rowsOf } from './AC-EV-F092-support.js';

const barrier = vi.hoisted(() => ({
  key: '',
  reached: undefined as undefined | (() => void),
  release: undefined as undefined | Promise<void>,
}));
vi.mock('../../apps/api/src/modules/employment/record-store.js', async (load) => {
  const original = await load<typeof import('../../apps/api/src/modules/employment/record-store.js')>();
  return {
    ...original,
    lockEmploymentEmployee: async (...args: Parameters<typeof original.lockEmploymentEmployee>) => {
      const result = await original.lockEmploymentEmployee(...args);
      if (args[1].commandId === barrier.key) {
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
    barrier.reached = undefined;
    barrier.release = undefined;
  });

  it('AC-EV-F092 离职先持员工锁：编辑真实等待，离职提交后旧 revision 返回 409、不能加回', async () => {
    const w = await exitWorld(database().db);
    const leaving = await w.hire('并发离职先行评委', w.orgA);
    const kept = await w.hire('并发离职留任评委', w.orgA);
    const g = await w.createGroup([leaving, kept]);
    const paused = signal();
    const release = signal();
    barrier.key = randomUUID();
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
    }
    expect((await edit).status).toBe(200);
    expect((await leave).status).toBe(201);
    await w.expectMembers(g.id, [added]);
    expect((await w.group(g.id)).revision).toBe(g.revision + 2);
    expect(await w.audits(g.id)).toHaveLength(2);
  });
});
