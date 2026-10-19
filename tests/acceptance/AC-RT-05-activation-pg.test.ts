/**
 * R2-T04 BE-5a / 真 PG 交错 ①②（设计 §13.3）。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * 交错不靠 Promise.all 碰运气：持锁会话占住员工行 / 组织设置锁，按固定先后启动请求，等 pg_stat_activity 里恰有 N 个会话
 * 在等锁（屏障）后才放锁（同 AC-EXIT-activation-pg）。
 * ① 退休申请最后节点同意 vs 同员工调动审批：按员工锁串行，两种先后都无死锁，退休生效且调动终归作废；
 * ② 组织停用（D ≥ E）vs 退休申请最后节点同意（写 R 预减）：串行一致的两种结果，不存在“停用按同意前的计数通过、而员工随后仍计入”。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { retirementWorld, type RetirementWorld } from './AC-RT-support.js';
import { tenantApi } from './support/tenant-api.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementWorld(database().db, label, TODAY);

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** 持锁会话：在一个事务里执行 lock，放行后才提交。 */
function holder(x: RetirementWorld, lock: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(x.db, x.session.tenant.id, async (tx) => {
    await lock(tx);
    held.resolve();
    await release.promise;
  });
  return { held: held.promise, release: release.resolve, done };
}

/** 先后启动的请求排在同一把锁后面：第 n 个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁。 */
async function queueBehind(
  x: RetirementWorld,
  lock: (tx: Tx) => Promise<unknown>,
  requests: readonly (() => Promise<unknown>)[],
) {
  const session = holder(x, lock);
  await session.held;
  const running: Promise<unknown>[] = [];
  for (const [index, request] of requests.entries()) {
    running.push(request());
    await waitForBlocked(x.db, index + 1);
  }
  session.release();
  await session.done;
  return Promise.allSettled(running);
}

const lockEmployee = (x: RetirementWorld) => (tx: Tx) =>
  tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.session.tenant.id}
    AND id=${x.employee.id}::uuid FOR NO KEY UPDATE`);

async function approveTransfer(x: RetirementWorld, businessId: string) {
  const instance = (await x.instanceOf(businessId))!;
  const [task] = await x.pendingTasks(instance.id);
  return x.api.request('POST', `/api/tenant/approval/tasks/${task!.id}/approve`, {
    tenant: x.session.tenant.id,
    user: task!.userId,
    ifMatch: instance.revision,
    body: {},
  });
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-05-pg ① 退休申请同意 vs 同员工调动审批', () => {
  it.each(['退休先', '调动审批先'] as const)(
    '员工行锁后两种先后（%s）：无死锁，退休生效且调动终归作废',
    async (order) => {
      const x = await world(`rt-pg-order-${order}`);
      const draft = await x.submittedRetire('2026-10-05');
      const review = await x.transferIn('in_review', '2026-10-30');
      const retireApproval = () => x.approveInReview(draft.id);
      const transferApproval = () => approveTransfer(x, review.id);
      const requests = order === '退休先' ? [retireApproval, transferApproval] : [transferApproval, retireApproval];

      const settled = await queueBehind(x, lockEmployee(x), requests);

      expect(
        settled.every((result) => result.status === 'fulfilled'),
        JSON.stringify(settled),
      ).toBe(true);
      expect(await x.stateOfBusiness(draft.id)).toBe('effective');
      expect(await x.stateOfBusiness(review.id)).toBe('voided');
      const instance = (await x.instanceOf(review.id))!;
      expect(instance.status).toBe(order === '退休先' ? 'cancelled' : 'approved');
      expect(await x.pendingTasks(instance.id)).toEqual([]);
      const transferResponse = (settled[order === '退休先' ? 1 : 0] as PromiseFulfilledResult<unknown>).value;
      if (order === '退休先') {
        // 退休先生效：调动审批实例已被取消并推进 revision，调动审批带旧 revision → 409 REVISION_CONFLICT；
        // 不能是审批路由把 40P01 死锁转成的 APPROVAL_CONCURRENT_CONFLICT（那表示锁序成环）
        const rejected = transferResponse as Response;
        const text = await rejected.clone().text();
        expect(rejected.status, text).toBe(409);
        expect(text).not.toContain('APPROVAL_CONCURRENT_CONFLICT');
        expect(JSON.parse(text)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
      } else expect((transferResponse as Response).status).toBe(200);
      expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    },
  );
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-05-pg ② 组织停用 vs 退休申请最后节点同意', () => {
  const disable = (x: RetirementWorld, effectiveDate: string) => () =>
    tenantApi(x.db, { clock: () => new Date(`${TODAY}T01:00:00Z`) }).request(
      'PATCH',
      `/api/tenant/org/organizations/${x.from.id}`,
      {
        tenant: x.session.tenant.id,
        user: x.session.user.id,
        ifMatch: x.from.revision,
        body: { enabled: false, effectiveDate },
      },
    );
  const orgLock = (x: RetirementWorld) => (tx: Tx) => lockOrganizationSettings(tx, x.session.tenant.id);

  it.each(['同意先', '停用先'] as const)(
    '停用日 D = 10-20 ≥ E = 10-15（%s）：串行一致，停用结果与是否已计预减一致',
    async (order) => {
      const x = await world(`rt-pg-deactivate-${order}`);
      const draft = await x.submittedRetire('2026-10-14');
      const approval = () => x.approveInReview(draft.id);
      const requests = order === '同意先' ? [approval, disable(x, '2026-10-20')] : [disable(x, '2026-10-20'), approval];

      const settled = await queueBehind(x, orgLock(x), requests);

      const [approved, stopped] = order === '同意先' ? settled : [settled[1]!, settled[0]!];
      expect(approved!.status, JSON.stringify(approved)).toBe('fulfilled');
      expect(stopped!.status, JSON.stringify(stopped)).toBe('fulfilled');
      const stopResponse = (stopped as PromiseFulfilledResult<Response>).value;
      expect(await x.stateOfBusiness(draft.id)).toBe('approved');
      expect(await x.exitRow(draft.id)).toMatchObject({ pre_release_date: TODAY });
      if (order === '同意先') expect(stopResponse.status, await stopResponse.clone().text()).toBe(200);
      else {
        // 停用先：此时员工仍计入（预减未写），停用被拒；同意随后成功
        expect(stopResponse.status).toBe(409);
        expect(await stopResponse.json()).toMatchObject({ error: { details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } } });
      }
    },
  );
});
