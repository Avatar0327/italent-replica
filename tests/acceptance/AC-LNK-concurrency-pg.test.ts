/**
 * R1-T10 真实 PostgreSQL 并发：联动与定时生效交错。F-008 取锁顺序为员工（UUID 升序）→ 业务 → 实例；
 * 职责转交的下属计入调动参与人，定时任务对被持锁的参与人整名员工跳过，不做部分联动。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { linkageWorld } from './AC-LNK-support.js';

const database = useTestDb();

async function waitForLockWaiters(db: Db, count: number) {
  for (let i = 0; i < 200; i++) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { n: number }[] }).rows) as { n: number }[];
    if (rows[0]!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('并发请求没有同时进入锁等待');
}

async function dutyFixture(label: string, cyclic = false) {
  const w = await linkageWorld(database().db, label);
  const manager = await w.hire('调动人');
  const subordinate = await w.hire('下属', { directManagerId: manager.employee.id });
  const receiver = await w.hire('接收人', cyclic ? { directManagerId: subordinate.employee.id } : {});
  const current = await w.contract(manager.employee.id);
  const business = await w.saved(
    await w.transfer(manager, {
      linkage: {
        contract: { targetId: current.id },
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.employee.id, receiverId: receiver.employee.id, relation: 'direct' }],
        },
      },
    }),
  );
  await w.approve(business, '2026-10-02T01:00:00Z');
  return { w, manager, subordinate, receiver, business };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('R1-T10 联动并发（真实 PG）', () => {
  it('两个定时实例同时到期执行：联动只执行一次（一份新合同、一条转交）', async () => {
    const { w, manager, business } = await dutyFixture('lnk-pg-twice');
    const runs = await Promise.all([w.runScheduler('2026-10-10T01:00:00Z'), w.runScheduler('2026-10-10T01:00:00Z')]);
    expect(runs.flatMap((run) => run.errors)).toEqual([]);
    expect(runs.flatMap((run) => run.activated)).toEqual([business.id]);
    expect(await w.contractChanges(manager.employee.id)).toHaveLength(1);
    expect((await w.linkage(business.id)).dutyTransfer).toMatchObject({ total: 1, failedCount: 0 });
  });

  it('下属被 HR 写入持锁时定时任务跳过该调动人，不做部分联动；释放后下一轮完整执行', async () => {
    const { w, subordinate, receiver, business } = await dutyFixture('lnk-pg-skip');
    let edit: Promise<Response> | undefined;
    const run = await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${subordinate.employee.id}::uuid FOR UPDATE`);
      const result = await w.runScheduler('2026-10-10T01:00:00Z');
      w.session.setNow('2026-10-10T01:00:00Z');
      const record = await w.business(subordinate.hire.id);
      edit = w.session.request('PATCH', `/records/${subordinate.hire.id}`, {
        ifMatch: record.revision,
        idempotencyKey: randomUUID(),
        body: { fields: { place: '交错地点' } },
      });
      await waitForLockWaiters(w.db, 1);
      return result;
    });
    expect(run).toMatchObject({ activated: [], failed: [], skippedLocked: 1, errors: [] });
    expect((await edit!).status).toBe(200);
    expect(await w.linkage(business.id)).toMatchObject({ executedAt: null, dutyTransfer: null, contract: null });
    const next = await w.runScheduler('2026-10-10T02:00:00Z');
    expect(next).toMatchObject({ activated: [business.id], errors: [] });
    expect(await w.managerOf(subordinate.hire.id)).toBe(receiver.employee.id);
  });

  it('同一失败子项两次并发重试：串行执行，一次 200、一次 409，次数只加一', async () => {
    const { w, manager, business } = await dutyFixture('lnk-pg-retry', true);
    await w.runScheduler('2026-10-10T01:00:00Z');
    const [item] = (await w.linkage(business.id)).dutyTransfer!.items;
    expect(item).toMatchObject({ status: 'failed', attemptCount: 1 });
    let pending: Promise<Response>[] = [];
    await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${manager.employee.id}::uuid FOR UPDATE`);
      pending = [w.retryItem(item!, randomUUID()), w.retryItem(item!, randomUUID())];
      await waitForLockWaiters(w.db, 2);
    });
    const statuses = (await Promise.all(pending)).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect((await w.linkage(business.id)).dutyTransfer!.items[0]).toMatchObject({ attemptCount: 2 });
  });
});
