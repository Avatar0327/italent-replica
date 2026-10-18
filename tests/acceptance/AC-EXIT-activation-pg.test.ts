/**
 * R2-T03 B3-3 真 PG 交错（设计 §9 ①④，§5.2 锁序）。PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 * 交错不靠 Promise.all 碰运气：先让持锁会话占住员工行 / 组织设置锁，再按固定先后启动请求，等 pg_stat_activity 里恰有 N 个
 * 会话在等锁（屏障）后才放锁；锁序用 NOWAIT 探针证明“等组织锁的生效事务此时还没拿审批实例锁”（④ 在 ⑥ 之前）。
 * ① 离职生效 vs 同员工调动审批（两种先后）；④ 调度 vs HR 重试、B-85a 共同迟到的两条重试并发；组织资源预锁覆盖
 * 调度 / 审批落地 / 直接保存 / HR 重试四条生效路径。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { activateDueBusinesses, retryActivation } from '../../apps/api/src/modules/employment/activation-service.js';
import { lockTransferParticipants } from '../../apps/api/src/modules/employment/transfer-locks.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { lockOrganizationSettings } from '../../apps/api/src/modules/org/locks.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const TODAY = '2026-10-06';
type World = Awaited<ReturnType<typeof downstreamWorld>>;

const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** 持锁会话：在一个事务里执行 lock 后等放行才提交。返回放行函数与结束 promise。 */
function holder(x: World, lock: (tx: Tx) => Promise<unknown>) {
  const held = signal();
  const release = signal();
  const done = withTenant(x.db, x.session.tenant.id, async (tx) => {
    await lock(tx);
    held.resolve();
    await release.promise;
  });
  return { held: held.promise, release: release.resolve, done };
}

const lockEmployee =
  (x: World, employeeId = x.employee.id) =>
  (tx: Tx) =>
    tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.session.tenant.id}
    AND id=${employeeId}::uuid FOR NO KEY UPDATE`);

/** 先后启动的请求排在同一把锁后面：第 n 个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁。 */
async function queueBehind(
  x: World,
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

/** NOWAIT 探针：该审批实例行此刻能否被另一个会话锁住。 */
async function lockable(x: World, instanceId: string) {
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

/** 审批中心对调动 T 的同意（单节点兜底流程）；返回响应。 */
async function approveTransfer(x: World, businessId: string) {
  const instance = (await x.instanceOf(businessId))!;
  const [task] = await x.pendingTasks(instance.id);
  return x.api.request('POST', `/api/tenant/approval/tasks/${task!.id}/approve`, {
    tenant: x.session.tenant.id,
    user: task!.userId,
    ifMatch: instance.revision,
    body: {},
  });
}

const world = (label: string) => downstreamWorld(database().db, label, TODAY);

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-activation-pg ① 离职生效 vs 同员工调动审批', () => {
  it.each(['离职先', '调动审批先'] as const)(
    '员工行锁后两种先后（%s）：无死锁，离职生效且调动终归作废',
    async (order) => {
      const x = await world(`pg-order-${order}`);
      const draft = await x.submittedLeave('2026-10-05');
      const review = await x.transferIn('in_review', '2026-10-30');
      // 离职申请两个节点：先同意第一个，最后一个节点与调动 T 的审批并发
      const leaveApproval = () => x.approveInReview(draft.id);
      const transferApproval = () => approveTransfer(x, review.id);
      const requests = order === '离职先' ? [leaveApproval, transferApproval] : [transferApproval, leaveApproval];

      const settled = await queueBehind(x, lockEmployee(x), requests);

      expect(
        settled.every((result) => result.status === 'fulfilled'),
        JSON.stringify(settled),
      ).toBe(true);
      expect(await x.stateOfBusiness(draft.id)).toBe('effective');
      expect(await x.stateOfBusiness(review.id)).toBe('voided');
      const instance = (await x.instanceOf(review.id))!;
      // 离职先生效：调动审批实例被取消；调动先同意：实例已办结（approved），业务随后被离职作废
      expect(instance.status).toBe(order === '离职先' ? 'cancelled' : 'approved');
      expect(await x.pendingTasks(instance.id)).toEqual([]);
      // 调动先同意：调动已批准，随后被离职作废（approved 候选）；离职先生效：调动审批已取消，同意被拒（409），不能把已作废的单批准
      const transferResponse = (settled[order === '离职先' ? 1 : 0] as PromiseFulfilledResult<unknown>).value;
      if (order === '离职先') expect((transferResponse as Response).status).toBe(409);
      else expect((transferResponse as Response).status).toBe(200);
      expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'leave']);
    },
  );
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-activation-pg ④ 调度 / 重试 / 审批落地交错', () => {
  /** 场景 S（§10.1）：T 计划 10-10 已批准，离职 E = 10-16；10-18 两笔都已到期、都迟到。 */
  async function sceneS(label: string, application = false) {
    const x = await world(label);
    const transfer = await x.transferIn('approved', '2026-10-10');
    const leave = application ? await x.submittedLeave('2026-10-15') : await x.directLeave('2026-10-15');
    return { x, transfer, leave };
  }
  const contextAt = (x: World, revision: number): EmploymentContext => ({
    tenantId: x.session.tenant.id,
    userId: x.session.user.id,
    timezone: x.session.tenant.timezone,
    now: new Date('2026-10-18T02:00:00Z'),
    commandId: randomUUID(),
    expectedRevision: revision,
  });
  /** 调度器对一名员工做的全部事（锁员工闭包 + 按队列逐条生效），做完不提交，持有员工行锁。 */
  const schedulerHolder = (x: World) =>
    holder(x, async (tx) => {
      const ctx = contextAt(x, 0);
      await lockTransferParticipants(tx, ctx, x.employee.id);
      await activateDueBusinesses(tx, ctx, x.employee.id, 'scheduler');
    });
  const outcomes = async (x: World, ids: readonly string[]) =>
    Promise.all(ids.map(async (id) => (await x.attempts(id)).map((row) => `${row.outcome}:${row.reason ?? ''}`)));

  it('调度先、HR 重试排在其后：重试带调度前的 revision，放锁后 409 REVISION_CONFLICT，不盲重试；终态 = 只有调度', async () => {
    const { x, transfer, leave } = await sceneS('pg-scheduler-then-retry');
    const stale = (await x.business(transfer.id)).revision;
    const session = schedulerHolder(x);
    await session.held;
    x.session.setNow('2026-10-18T03:00:00Z');
    const retrying = x.session.request('POST', `/businesses/${transfer.id}/activation/retry`, {
      ifMatch: stale,
      body: {},
    });
    await waitForBlocked(x.db, 1);
    session.release();
    await session.done;
    expect(await x.reason(await retrying)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(await outcomes(x, [transfer.id, leave.id])).toEqual([
      ['failed:REBUILD_REQUIRED'],
      ['suspended:PREDECESSOR_FAILED'],
    ]);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });

  it('调度先、离职审批落地排在其后：审批动作成功，落地因前序失败记 suspended（trigger = approval），不越过 T', async () => {
    const { x, transfer, leave } = await sceneS('pg-scheduler-then-approval', true);
    const session = schedulerHolder(x);
    await session.held;
    const approving = x.approve(leave, '2026-10-18T03:00:00Z');
    await waitForBlocked(x.db, 1);
    session.release();
    await session.done;
    expect((await approving).status).toBe('approved');
    expect((await x.attempts(transfer.id)).map((row) => row.reason)).toEqual(['REBUILD_REQUIRED']);
    expect((await x.attempts(leave.id)).map((row) => [row.outcome, row.blocked_by_business_id])).toEqual([
      ['suspended', transfer.id],
    ]);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });

  it('HR 重试先、调度后：重试事务持锁期间调度无事可做；放锁后终态同顺序执行（不重复记尝试）', async () => {
    const { x, transfer, leave } = await sceneS('pg-retry-then-scheduler');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({
      failed: [transfer.id],
      suspended: [leave.id],
    });
    const revision = (await x.business(transfer.id)).revision;
    const session = holder(x, async (tx) => {
      await retryActivation(tx, contextAt(x, revision), transfer.id, x.employee.id);
    });
    await session.held;
    expect(await x.runScheduler('2026-10-18T04:00:00Z')).toMatchObject({ activated: [], failed: [], suspended: [] });
    session.release();
    await session.done;
    expect(await x.runScheduler('2026-10-18T05:00:00Z')).toMatchObject({ activated: [], failed: [], suspended: [] });
    expect(await outcomes(x, [transfer.id, leave.id])).toEqual([
      ['failed:REBUILD_REQUIRED', 'failed:REBUILD_REQUIRED'],
      ['suspended:PREDECESSOR_FAILED'],
    ]);
  });

  it.each(['T 先', '离职先'] as const)(
    'B-85a 共同迟到：T 与离职的两条 HR 重试并发（%s）：结果同顺序执行，离职重试 409 PREDECESSOR_FAILED',
    async (order) => {
      const { x, transfer, leave } = await sceneS(`pg-b85a-${order}`);
      expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({
        failed: [transfer.id],
        suspended: [leave.id],
      });
      const revisions = new Map([
        [transfer.id, (await x.business(transfer.id)).revision],
        [leave.id, (await x.business(leave.id)).revision],
      ]);
      x.session.setNow('2026-10-18T02:00:00Z');
      const retry = (id: string) => () =>
        x.session.request('POST', `/businesses/${id}/activation/retry`, { ifMatch: revisions.get(id)!, body: {} });
      const [first, second] = order === 'T 先' ? [transfer.id, leave.id] : [leave.id, transfer.id];
      const settled = await queueBehind(x, lockEmployee(x), [retry(first), retry(second)]);
      const responses = new Map(
        [first, second].map((id, index) => [id, (settled[index] as PromiseFulfilledResult<Response>).value]),
      );
      // 离职无论先后都因前序 T 失败被拒；T 重试再次判定区间（离职申请仍在区间内）→ REBUILD_REQUIRED，请求本身 200
      expect(await x.reason(responses.get(leave.id)!)).toMatchObject({ status: 409, reason: 'PREDECESSOR_FAILED' });
      expect(responses.get(transfer.id)!.status).toBe(200);
      expect(await outcomes(x, [transfer.id, leave.id])).toEqual([
        ['failed:REBUILD_REQUIRED', 'failed:REBUILD_REQUIRED'],
        ['suspended:PREDECESSOR_FAILED'],
      ]);
      expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    },
  );
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-EXIT-activation-pg 组织资源预锁：④ 先于 ⑥（设计 §5.2）',
  () => {
    /**
     * 到期的离职 + 在途调动 T（审批中，有实例）：离职先建（T 在后建，避免保存时要求确认令牌）。
     * 持锁会话占住组织设置锁，生效事务应在组织锁上排队、此时还没拿审批实例锁。
     */
    async function scene(label: string, leaveAt: 'direct-due' | 'application' | 'failed') {
      const x = await world(label);
      const leave =
        leaveAt === 'application'
          ? await x.submittedLeave('2026-10-05')
          : await x.directLeave(leaveAt === 'direct-due' ? '2026-10-15' : '2026-10-10');
      const review = await x.transferIn('in_review', '2026-10-30');
      return { x, leave, review, reviewInstance: (await x.instanceOf(review.id))! };
    }
    const orgLock = (x: World) => (tx: Tx) => lockOrganizationSettings(tx, x.session.tenant.id);

    async function expectOrderedBehindOrgLock(x: World, instanceIds: readonly string[], start: () => Promise<unknown>) {
      const session = holder(x, orgLock(x));
      await session.held;
      const running = start();
      await waitForBlocked(x.db, 1);
      // 生效事务在等组织锁：此刻它不得已持有任何审批实例锁（否则与“组织锁 → 审批实例”的其他路径成环）
      for (const id of instanceIds) expect(await lockable(x, id), `实例 ${id} 不应被生效事务持有`).toBe(true);
      session.release();
      await session.done;
      return running;
    }

    it('调度到期生效', async () => {
      const { x, leave, review, reviewInstance } = await scene('pg-prelock-scheduler', 'direct-due');
      const done = await expectOrderedBehindOrgLock(x, [reviewInstance.id], () =>
        x.runScheduler('2026-10-16T01:00:00Z'),
      );
      expect(done).toMatchObject({ activated: [leave.id] });
      expect(await x.stateOfBusiness(review.id)).toBe('voided');
    });

    it('审批落地（审批中心最后节点）：适配器在取审批实例锁之前先取组织锁', async () => {
      const { x, leave: draft, review, reviewInstance } = await scene('pg-prelock-approval', 'application');
      const leaveInstance = (await x.instanceOf(draft.id))!;
      const done = await expectOrderedBehindOrgLock(x, [reviewInstance.id, leaveInstance.id], () =>
        x.approveInReview(draft.id),
      );
      expect(done).toBeUndefined();
      expect(await x.stateOfBusiness(draft.id)).toBe('effective');
      expect(await x.stateOfBusiness(review.id)).toBe('voided');
    });

    it('直接离职保存当场生效', async () => {
      const x = await world('pg-prelock-direct');
      const review = await x.transferIn('in_review', '2026-10-30');
      const reviewInstance = (await x.instanceOf(review.id))!;
      const unconfirmed = await x.reason(await x.createLeave(x.employee.id, leaveBody('2026-10-05', 'direct')));
      expect(unconfirmed.ackToken).toBeTruthy();
      const response = (await expectOrderedBehindOrgLock(x, [reviewInstance.id], () =>
        x.createLeave(x.employee.id, leaveBody('2026-10-05', 'direct', { pendingTransferAck: unconfirmed.ackToken })),
      )) as Response;
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await x.stateOfBusiness(review.id)).toBe('voided');
    });

    it('HR 重试：生效失败后重试同样先取组织锁', async () => {
      const { x, leave, review, reviewInstance } = await scene('pg-prelock-retry', 'failed');
      let fail = true;
      exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => {
        if (fail && event.businessId === leave.id)
          throw new AppError('CONFLICT', '后续任务失败', { reason: 'DOWNSTREAM_FAILED' });
      });
      expect(await x.runScheduler('2026-10-11T01:00:00Z')).toMatchObject({ failed: [leave.id] });
      fail = false;
      const response = (await expectOrderedBehindOrgLock(x, [reviewInstance.id], () =>
        x.retry(leave, '2026-10-11T03:00:00Z'),
      )) as Response;
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await x.stateOfBusiness(leave.id)).toBe('effective');
      expect(await x.stateOfBusiness(review.id)).toBe('voided');
    });
  },
);
