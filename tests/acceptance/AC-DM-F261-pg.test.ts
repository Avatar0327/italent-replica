/** F-261：真实 PG 上改期提交与全局停用交错，不能使用等待前的旧计划。 */
import './support/exit-gate-enforced.js';
import { getUser, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { settledOrBlocked, waitForBlocked, withHeldLock } from './support/pg-interleave.js';

const database = useTestDb();
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function scene(label: string) {
  const x = await downstreamWorld(database().db, `f261-pg-${label}`);
  const userId = await x.applicantAccount(x.employee.id);
  const configured = await x.session.request('PUT', '/exit-account/settings', {
    ifMatch: 0,
    body: { earlyEnabled: true, basis: 'last_work_date', time: '19:00', inReview: false },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);
  const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-06', 'direct', { exitTypeCode: 'voluntary' }));
  return { x, userId, leave };
}
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-261 PG 锁交错', () => {
  it('AC-DM-20 / F-359 人工重试与调度写回交错：账号停用凭据不可丢，随后撤销仍能恢复', async () => {
    const { x, userId, leave } = await scene('retry-race');
    x.setNow('2026-10-06T11:00:00Z');
    const before = (await getUser(x.db, userId))!;
    // 沿用 F-328 的存储故障注入：由真实调度记录 failed，不直接改任务状态；交错前卸载故障。
    await x.db.execute(sql`CREATE FUNCTION f261_fail_disable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'disabled' AND OLD.status = 'active' THEN
        RAISE EXCEPTION 'synthetic disable storage failure' USING ERRCODE = '53100';
      END IF; RETURN NEW; END $$`);
    try {
      await x.db.execute(sql`CREATE TRIGGER f261_fail_disable BEFORE UPDATE OF status ON users
        FOR EACH ROW EXECUTE FUNCTION f261_fail_disable()`);
      await x.runScheduler('2026-10-06T11:00:00Z');
    } finally {
      await x.db.execute(sql`DROP TRIGGER IF EXISTS f261_fail_disable ON users`);
      await x.db.execute(sql`DROP FUNCTION f261_fail_disable()`);
    }
    const task = await (await x.session.request('GET', `/exit-account/tasks/${leave.id}`)).json();
    expect(task).toMatchObject({ status: 'failed', attempts: 1 });
    expect(task.reason).toEqual(expect.any(String));
    expect(await getUser(x.db, userId)).toEqual(before);
    await withHeldLock(
      {
        run: (fn) => withTenant(x.db, x.session.tenant.id, fn),
        take: (tx) =>
          tx.execute(sql`SELECT 1 FROM exit_account_tasks
          WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid FOR UPDATE`),
      },
      async (lock) => {
        const retrying = lock.track(
          x.session.request('POST', `/exit-account/tasks/${leave.id}/retry`, {
            ifMatch: task.revision,
            body: {},
          }),
        );
        await waitForBlocked(x.db, 1);
        const scheduling = lock.track(x.runScheduler('2026-10-06T11:00:00Z'));
        await waitForBlocked(x.db, 2);
        await lock.release();
        expect((await retrying).status).toBe(200);
        await scheduling;
      },
    );
    const disabled = (await getUser(x.db, userId))!;
    expect(disabled.status).toBe('disabled');
    const [saved] = await x.sqlRows<{ auto: number | null }>(sql`SELECT auto_revision AS auto FROM exit_account_tasks
      WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid`);
    expect(saved!.auto).toBe(disabled.revision);
    const cancelled = await x.session.request('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '合成并发撤销' },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect((await getUser(x.db, userId))!.status).toBe('active');
  });

  it('AC-DM-20 / F-359 pending 人工重试不等任务行锁，回 200 且 revision 不变', async () => {
    const { x, userId, leave } = await scene('pending-noop');
    // 已到停用时间：若空操作错误地触发消费，会等待行锁或停用账号。
    x.setNow('2026-10-06T11:00:00Z');
    const task = await (await x.session.request('GET', `/exit-account/tasks/${leave.id}`)).json();
    expect(task.status).toBe('pending');
    const before = await getUser(x.db, userId);
    const storedTask = () =>
      x.sqlRows(sql`SELECT * FROM exit_account_tasks
      WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid`);
    const stored = await storedTask();
    await withHeldLock(
      {
        run: (fn) => withTenant(x.db, x.session.tenant.id, fn),
        take: (tx) =>
          tx.execute(sql`SELECT 1 FROM exit_account_tasks
          WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid FOR UPDATE`),
      },
      async (lock) => {
        const retrying = lock.track(
          x.session.request('POST', `/exit-account/tasks/${leave.id}/retry`, {
            ifMatch: task.revision,
            body: {},
          }),
        );
        expect(await settledOrBlocked(x.db, retrying, 1)).toBe('settled');
        const response = await retrying;
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ businessId: leave.id, status: 'pending', revision: task.revision });
        expect(await storedTask()).toEqual(stored);
        expect(await getUser(x.db, userId)).toEqual(before);
      },
    );
  });

  it('改期事务持员工锁时启动到点调度：等待结束重读未来日期，不能按旧计划停用', async () => {
    const { x, userId, leave } = await scene('replan');
    const held = signal(),
      release = signal();
    exitPostEffectHooks.onReplanned(async (_tx, _ctx, event) => {
      if (event.businessId !== leave.id) return;
      held.resolve();
      await release.promise;
    });
    const changing = x.session.request('PATCH', `/exits/${leave.id}`, {
      ifMatch: leave.revision,
      body: { lastWorkDate: '2026-10-20' },
    });
    let scheduling: ReturnType<typeof x.runScheduler> | undefined;
    try {
      await Promise.race([
        held.promise,
        changing.then(async (r) => {
          throw new Error(`未进入改期出口：${r.status} ${await r.text()}`);
        }),
      ]);
      scheduling = x.runScheduler('2026-10-06T11:00:00Z');
      await waitForBlocked(x.db, 1);
    } finally {
      release.resolve();
    }
    expect((await changing).status).toBe(200);
    await scheduling;
    expect((await getUser(x.db, userId))!.status).toBe('active');
    expect((await x.business(leave.id)).effectiveDate).toBe('2026-10-21');
  });
  it('两个调度同时过点：账号只更新一次，任务同一条，重复运行无新增副作用', async () => {
    const { x, userId, leave } = await scene('two');
    const before = (await getUser(x.db, userId))!;
    await Promise.all([x.runScheduler('2026-10-06T11:00:00Z'), x.runScheduler('2026-10-06T11:00:00Z')]);
    const after = (await getUser(x.db, userId))!;
    expect(after.status).toBe('disabled');
    expect(after.revision).toBe(before.revision + 1);
    await x.runScheduler('2026-10-06T11:01:00Z');
    expect(await getUser(x.db, userId)).toEqual(after);
    const task = await x.session.request('GET', `/exit-account/tasks/${leave.id}`);
    expect(task.status).toBe(200);
    expect(await task.json()).toMatchObject({ status: 'disabled' });
  });
});
