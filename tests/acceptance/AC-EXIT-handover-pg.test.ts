/**
 * R2 BE-8b2 真 PG 交错（DEC-632，第 2 轮 P2-3）：离职申请审批通过（发起交接）与撤销离职并发。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。交错不靠 Promise.all 碰运气：先让持锁会话占住员工行，
 * 再按固定先后启动两个请求，等 pg_stat_activity 里恰有 N 个会话在等锁（屏障）后才放锁，PG 对同一把锁的等待者按到达顺序放行。
 * 两种顺序都断言每个操作的结果、离职与审批实例状态、交接状态：
 * - 审批先成功：随后的撤销带着审批前读到的旧 revision → 409；刷新后显式重提撤销成功，交接被终止、审批实例被系统撤销；
 * - 撤销先成功：随后的审批失败，离职保持已撤销，没有交接单也没有交接审批实例。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { FUTURE_LAST_WORK_DATE, handoverWorld, TODAY, type HandoverWorld } from './AC-EXIT-handover-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const itPg = process.env.TEST_DATABASE_URL ? it : it.skip;
const APPROVE_AT = `${TODAY}T02:00:00Z`;

/** 持锁会话占住员工行；按给定先后启动请求，每个请求发出后等恰有 n 个会话在等锁，全部排队后才放锁。 */
async function queueBehindEmployee(x: HandoverWorld, requests: readonly (() => Promise<unknown>)[]) {
  let held!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = withTenant(x.db, x.tenantId, async (tx) => {
    await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${x.tenantId}
      AND id=${x.employee.id}::uuid FOR NO KEY UPDATE`);
    held();
    await released;
  });
  await holding;
  const running: Promise<unknown>[] = [];
  for (const [index, request] of requests.entries()) {
    running.push(request());
    await waitForBlocked(x.db, index + 1);
  }
  release();
  await holder;
  return Promise.all(running);
}

async function submitted(x: HandoverWorld) {
  const draft = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'application', {
    exitTypeCode: 'voluntary',
    handoverEmployeeId: x.workOwner.employeeId,
  });
  const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
  return draft;
}

async function world(label: string) {
  const x = await handoverWorld(database().db, label);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  return x;
}

describe('离职交接并发（真 PG，屏障强制两种交错顺序）', () => {
  itPg('审批先成功：旧 revision 撤销 409；刷新后显式重提撤销成功并终止交接', async () => {
    const x = await world('pg-approve-first');
    const draft = await submitted(x);
    const staleRevision = (await x.business(draft.id)).revision;
    const cancel = (revision: number) =>
      x.session.request('POST', `/exits/${draft.id}/cancel`, { ifMatch: revision, body: { reason: '并发撤销' } });
    const [approved, stale] = (await queueBehindEmployee(x, [
      () => x.tryApprove(draft, APPROVE_AT),
      () => cancel(staleRevision),
    ])) as [Awaited<ReturnType<typeof x.tryApprove>>, Response];
    expect(approved).toMatchObject({ ok: true });
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect((await x.business(draft.id)).status).toBe('approved');
    const [request] = await x.requestRows(draft.id);
    expect(request).toMatchObject({ state: 'in_progress', endReason: null });
    expect(await x.instanceStatus(request!.instanceId!)).toBe('running');
    // 刷新后显式重提撤销
    const retried = await cancel((await x.business(draft.id)).revision);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.requestRows(draft.id))[0]).toMatchObject({ state: 'terminated', endReason: 'exit_cancelled' });
    expect(await x.instanceStatus(request!.instanceId!)).toBe('cancelled');
    expect((await x.business(draft.id)).status).toBe('voided');
  });

  itPg('撤销先成功：审批失败，离职保持已撤销，没有交接单也没有交接审批实例', async () => {
    const x = await world('pg-cancel-first');
    const draft = await submitted(x);
    const revision = (await x.business(draft.id)).revision;
    const [cancelled, approved] = (await queueBehindEmployee(x, [
      () => x.session.request('POST', `/exits/${draft.id}/cancel`, { ifMatch: revision, body: { reason: '并发撤销' } }),
      () => x.tryApprove(draft, APPROVE_AT),
    ])) as [Response, Awaited<ReturnType<typeof x.tryApprove>>];
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(approved.ok).toBe(false);
    expect((await x.business(draft.id)).status).toBe('voided');
    expect(await x.requestRows(draft.id)).toEqual([]);
    expect(await x.handoverInstanceCount()).toBe(0);
  });
});
