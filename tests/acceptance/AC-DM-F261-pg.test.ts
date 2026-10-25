/** F-261：真实 PG 上改期提交与全局停用交错，不能使用等待前的旧计划。 */
import './support/exit-gate-enforced.js';
import { getUser } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

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
    expect((await x.business(leave.id)).lastWorkDate).toBe('2026-10-20');
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
