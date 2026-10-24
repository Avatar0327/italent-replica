/**
 * R2-T03 B4 真 PG 交错（设计 §9 ② ⑤，§5.2 锁序）。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * 交错不靠 Promise.all 碰运气：持锁会话先占住员工行 / 组织设置锁，再按固定先后启动请求，等 pg_stat_activity 里恰有 N 个
 * 会话在等锁（屏障）后才放锁；锁序用 NOWAIT 探针证明“等组织锁的撤销事务此时还没拿审批实例锁”（组织 → 实例）。
 * ② 撤销 vs 定时生效（两种先后）：恰一方生效；⑤ 组织停用 vs 撤销 approved 离职（两种先后）：恰一方成功（§6B）。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { activateDueBusinesses } from '../../apps/api/src/modules/employment/activation-service.js';
import { cancelExit } from '../../apps/api/src/modules/employment/exit-cancel.js';
import { lockTransferParticipants } from '../../apps/api/src/modules/employment/transfer-locks.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { cancelWorld, type CancelWorld } from './AC-EXIT-cancel-support.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => cancelWorld(database().db, label, TODAY);
const live = Boolean(process.env.TEST_DATABASE_URL);

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** 持锁会话：在一个事务里执行 lock 后等放行才提交。 */
function holder(x: CancelWorld, lock: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(x.db, x.session.tenant.id, async (tx) => {
    await lock(tx);
    held.resolve();
    await release.promise;
  });
  return { held: held.promise, release: release.resolve, done };
}

const lockOrg = (x: CancelWorld) => (tx: Tx) => lockOrganizationSettings(tx, x.session.tenant.id);

/** 先后启动的请求排在同一把锁后面：第 n 个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁（出错也放锁，不拖垮后面的用例）。 */
async function queueBehind(x: CancelWorld, lock: (tx: Tx) => Promise<unknown>, requests: (() => Promise<unknown>)[]) {
  const session = holder(x, lock);
  await session.held;
  const running: Promise<unknown>[] = [];
  await withRelease(
    () => session.release(),
    async (cleanup) => {
      cleanup.track(session.done);
      for (const [index, request] of requests.entries()) {
        running.push(cleanup.track(request()));
        await waitForBlocked(x.db, index + 1);
      }
    },
    [session.done],
  );
  return Promise.allSettled(running);
}

/** NOWAIT 探针：该审批实例行此刻能否被另一个会话锁住。 */
async function lockable(x: CancelWorld, instanceId: string) {
  try {
    await withTenant(x.db, x.session.tenant.id, (tx) =>
      tx.execute(sql`SELECT id FROM approval_instances WHERE tenant_id=${x.session.tenant.id}
        AND id=${instanceId}::uuid FOR UPDATE NOWAIT`),
    );
    return true;
  } catch (error) {
    if (String((error as { cause?: unknown }).cause ?? error).includes('could not obtain lock')) return false;
    throw error;
  }
}

const response = (settled: PromiseSettledResult<unknown>) => (settled as PromiseFulfilledResult<Response>).value;

describe.runIf(live)('AC-EXIT-cancel-pg ② 撤销 vs 定时生效', () => {
  /** 离职 L = 10-15（E = 10-16）已批准；调度与 HR 撤销都在 10-17 执行。 */
  async function scene(label: string) {
    const x = await world(label);
    const leave = await x.directLeave('2026-10-15');
    const revision = (await x.business(leave.id)).revision;
    x.session.setNow('2026-10-17T01:00:00Z');
    const contextAt = (): EmploymentContext => ({
      tenantId: x.session.tenant.id,
      userId: x.session.user.id,
      timezone: x.session.tenant.timezone,
      now: new Date('2026-10-17T02:00:00Z'),
      commandId: randomUUID(),
      expectedRevision: revision,
    });
    return { x, leave, revision, contextAt };
  }

  it('撤销事务持锁期间调度无事可做（跳过被锁的员工）；放锁后离职已作废，再调度仍无事可做', async () => {
    const { x, leave, contextAt } = await scene('pg-cancel-first');
    const session = holder(x, (tx) => cancelExit(tx, contextAt(), leave.id, { reason: '撤销' }));
    await session.held;
    try {
      expect(await x.runScheduler('2026-10-17T01:00:00Z')).toMatchObject({ activated: [], failed: [], suspended: [] });
    } finally {
      session.release();
      await session.done;
    }
    expect(await x.stateOfBusiness(leave.id)).toBe('voided');
    expect(await x.runScheduler('2026-10-17T03:00:00Z')).toMatchObject({ activated: [] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(await x.cancellationOf(leave.id)).toMatchObject({ case: 'approved_voided' });
  });

  it('调度事务先持锁、撤销排在其后：离职生效，撤销带的是调度前的 revision → 409 REVISION_CONFLICT，不盲重试', async () => {
    const { x, leave, revision, contextAt } = await scene('pg-schedule-first');
    const session = holder(x, async (tx) => {
      const ctx = contextAt();
      await lockTransferParticipants(tx, ctx, x.employee.id);
      await activateDueBusinesses(tx, ctx, x.employee.id, 'scheduler');
    });
    await session.held;
    let cancelling: Promise<Response> | undefined;
    await withRelease(
      () => session.release(),
      async (cleanup) => {
        cleanup.track(session.done);
        cancelling = cleanup.track(x.cancel(leave.id, { reason: '撤销' }, { ifMatch: revision }));
        await waitForBlocked(x.db, 1);
      },
      [session.done],
    );
    expect(await x.reason(await cancelling!)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');
    expect(await x.cancellationOf(leave.id)).toBeUndefined();
    // 带最新 revision 显式重提：撤销已生效离职（恢复在职）
    const retry = await x.cancel(leave.id, { reason: '重提' });
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await x.cancellationOf(leave.id)).toMatchObject({ case: 'record_deleted_reinstated' });
  });
});

describe.runIf(live)('AC-EXIT-cancel-pg ⑤ 组织停用 vs 撤销 approved 离职（恰一方成功）', () => {
  /** 离职 E = 10-21 已批准，A 的停用 10-22 起（按 §6A.1 允许：approved 离职从 E 起不计占用）。 */
  async function scene(label: string) {
    const x = await world(label);
    const leave = await x.directLeave('2026-10-20');
    const revision = (await x.business(leave.id)).revision;
    const cancel = () => x.cancel(leave.id, { reason: '撤销' }, { ifMatch: revision });
    const disable = () => x.disable(x.from, '2026-10-22');
    return { x, leave, cancel, disable };
  }

  it('停用先、撤销后：停用成功，撤销 409 EMPLOYMENT_DEPARTMENT_DISABLED，离职仍 approved', async () => {
    const { x, leave, cancel, disable } = await scene('pg-disable-first');
    const settled = await queueBehind(x, lockOrg(x), [disable, cancel]);

    expect(response(settled[0]!).status).toBe(200);
    expect(await x.reason(response(settled[1]!))).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect(await x.cancellationOf(leave.id)).toBeUndefined();
  });

  it('撤销先、停用后：撤销成功，停用 409 ORG_SUBTREE_NOT_EMPTY', async () => {
    const { x, leave, cancel, disable } = await scene('pg-cancel-first-org');
    const settled = await queueBehind(x, lockOrg(x), [cancel, disable]);

    expect(response(settled[0]!).status).toBe(200);
    const stopped = response(settled[1]!);
    expect(stopped.status, await stopped.clone().text()).toBe(409);
    expect(await stopped.json()).toMatchObject({ error: { details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } } });
    expect(await x.stateOfBusiness(leave.id)).toBe('voided');
  });
});

describe.runIf(live)('AC-EXIT-cancel-pg 锁序：员工 / 业务 → 组织 → 审批实例', () => {
  it('撤销审批中的离职：在组织锁上排队时还没拿审批实例锁', async () => {
    const x = await world('pg-lock-order');
    const draft = await x.submittedLeave('2026-10-20');
    const instance = (await x.instanceOf(draft.id))!;
    const session = holder(x, lockOrg(x));
    await session.held;
    let running: Promise<Response> | undefined;
    await withRelease(
      () => session.release(),
      async (cleanup) => {
        cleanup.track(session.done);
        running = cleanup.track(x.cancel(draft.id, { reason: '撤销' }));
        await waitForBlocked(x.db, 1);
        expect(await lockable(x, instance.id), '撤销事务不应在等组织锁时持有审批实例锁').toBe(true);
      },
      [session.done],
    );
    const done = await running!;
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await x.instanceOf(draft.id))!.status).toBe('cancelled');
  });
});
