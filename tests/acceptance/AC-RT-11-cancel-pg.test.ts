/**
 * R2-T04 BE-5a′ / AC-RT-11-cancel-pg（设计 §13 ③）：组织停用 vs 撤销已批准退休（预减收回、恢复在职区间），恰一方成功（XOR）。
 * 与离职同一把锁序（员工 / 业务 → 组织 → 编制 → 审批实例）和同一 §6B 公式；交错方式同 AC-EXIT-cancel-pg ⑤
 * （持锁会话占住组织设置锁，按先后启动请求，等 pg_stat_activity 里恰有 N 个会话在等锁后才放锁）。PGlite 单连接无法并发，
 * 只在设了 TEST_DATABASE_URL 时运行。
 */
import './support/exit-gate-enforced.js';
import { withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { retirementCancelWorld, type RetirementCancelWorld } from './AC-RT-cancel-support.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const live = Boolean(process.env.TEST_DATABASE_URL);

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** 持锁会话：在一个事务里执行 lock 后等放行才提交。 */
function holder(x: RetirementCancelWorld, lock: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(x.db, x.session.tenant.id, async (tx) => {
    await lock(tx);
    held.resolve();
    await release.promise;
  });
  return { held: held.promise, release: release.resolve, done };
}

/** 先后启动的请求排在同一把锁后面；全部排队后才放锁（出错也放锁，不拖垮后面的用例）。 */
async function queueBehind(x: RetirementCancelWorld, requests: (() => Promise<unknown>)[]) {
  const session = holder(x, (tx) => lockOrganizationSettings(tx, x.session.tenant.id));
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

const response = (settled: PromiseSettledResult<unknown>) => (settled as PromiseFulfilledResult<Response>).value;

describe.runIf(live)('AC-RT-11-cancel-pg ③ 组织停用 vs 撤销 approved 退休（恰一方成功）', () => {
  /** 退休 E = 10-21 已批准，A 的停用 10-22 起（按 §6A.1 允许：approved 退休从 E 起不计占用）。 */
  async function scene(label: string) {
    const x = await retirementCancelWorld(database().db, label, TODAY);
    const retire = await x.directRetire('2026-10-20');
    const revision = (await x.business(retire.id)).revision;
    const cancel = () => x.cancelRetire(retire.id, { reason: '撤销' }, { ifMatch: revision });
    const disable = () => x.disable(x.from, '2026-10-22');
    return { x, retire, cancel, disable };
  }

  it('停用先、撤销后：停用成功，撤销 409 EMPLOYMENT_DEPARTMENT_DISABLED，退休仍 approved', async () => {
    const { x, retire, cancel, disable } = await scene('rt-pg-disable-first');
    const settled = await queueBehind(x, [disable, cancel]);

    expect(response(settled[0]!).status).toBe(200);
    expect(await x.reason(response(settled[1]!))).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect(await x.stateOfBusiness(retire.id)).toBe('approved');
    expect(await x.cancellationOf(retire.id)).toBeUndefined();
  });

  it('撤销先、停用后：撤销成功，停用 409 ORG_SUBTREE_NOT_EMPTY（员工计入）', async () => {
    const { x, retire, cancel, disable } = await scene('rt-pg-cancel-first');
    const settled = await queueBehind(x, [cancel, disable]);

    expect(response(settled[0]!).status).toBe(200);
    const stopped = response(settled[1]!);
    expect(stopped.status, await stopped.clone().text()).toBe(409);
    expect(await stopped.json()).toMatchObject({ error: { details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } } });
    expect(await x.stateOfBusiness(retire.id)).toBe('voided');
    expect(await x.cancellationOf(retire.id)).toMatchObject({ case: 'approved_voided' });
  });
});
