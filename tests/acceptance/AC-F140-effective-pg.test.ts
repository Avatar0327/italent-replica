/** F-140b2：真 PG 普通角色下员工行锁交错，PGlite 不模拟并发。 */
import './support/exit-gate-enforced.js';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
type World = Awaited<ReturnType<typeof downstreamWorld>>;
async function queued(x: World, operations: readonly (() => Promise<Response>)[]) {
  const held = signal(),
    release = signal();
  const holder = withTenant(x.db, x.session.tenant.id, async (tx: Tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${x.session.tenant.id} AND id=${x.employee.id}::uuid FOR NO KEY UPDATE`);
    held.resolve();
    await release.promise;
  });
  const pending: Promise<Response>[] = [];
  try {
    await held.promise;
    for (const [index, operation] of operations.entries()) {
      pending.push(operation());
      await waitForBlocked(x.db, index + 1);
    }
  } finally {
    release.resolve();
  }
  await holder;
  return Promise.all(pending);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-140b2 PG 改期锁交错', () => {
  it('两次改期同 revision：后者 409，刷新重提看到前者日期，版本单调', async () => {
    const x = await downstreamWorld(database().db, 'f140-pg-two');
    const initial = await x.directLeave('2026-10-15');
    await x.runScheduler('2026-10-16T01:00:00Z');
    const leave = await x.business(initial.id);
    x.setNow('2026-11-05T01:00:00Z');
    const change = (date: string, revision: number) => () =>
      x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: revision,
        body: { lastWorkDate: date },
      });
    const [first, second] = await queued(x, [
      change('2026-10-29', leave.revision),
      change('2026-10-24', leave.revision),
    ]);
    expect(first!.status, await first!.clone().text()).toBe(200);
    expect(await x.reason(second!)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    const current = await x.business(leave.id);
    expect(current.effectiveDate).toBe('2026-10-30');
    expect((await change('2026-10-24', current.revision)()).status).toBe(200);
    const versions = await x.versions(leave.id);
    expect(versions.slice(-2).map((row) => row.planned)).toEqual(['2026-10-30', '2026-10-25']);
    expect(versions.at(-1)!.version_no).toBe(versions.at(-2)!.version_no + 1);
    const events = await x.audits(leave.id, 'employment.leave.replanned');
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        before: { plannedEffectiveDate: '2026-10-30' },
        after: { plannedEffectiveDate: '2026-10-25', versionNo: versions.at(-1)!.version_no },
      }),
    );
  });

  it('改期先持锁时调度跳过；释放后只按新日期执行', async () => {
    const x = await downstreamWorld(database().db, 'f140-pg-scheduler');
    const initial = await x.directLeave('2026-10-15');
    await x.runScheduler('2026-10-16T01:00:00Z');
    const leave = await x.business(initial.id);
    x.setNow('2026-10-20T01:00:00Z');
    const held = signal(),
      release = signal();
    const { exitPostEffectHooks } = await import('../../apps/api/src/modules/employment/exit-confirmation.js');
    exitPostEffectHooks.onReplanned(async (_tx, _ctx, event) => {
      if (event.supersedesBusinessId !== leave.id) return;
      held.resolve();
      await release.promise;
    });
    const changing = x.session.request('PATCH', `/exits/${leave.id}`, {
      ifMatch: leave.revision,
      body: { lastWorkDate: '2026-10-29' },
    });
    try {
      await Promise.race([
        held.promise,
        changing.then(async (response) => {
          throw new Error(`未进入改期出口：${response.status} ${await response.clone().text()}`);
        }),
      ]);
      expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [], failed: [] });
    } finally {
      release.resolve();
    }
    const response = await changing;
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [] });
    expect(await x.runScheduler('2026-10-30T01:00:00Z')).toMatchObject({ activated: [result.successor.id] });
  });
});
