/**
 * F-310 / F-365（DEC-663、DEC-674）：自动交接开启、流程可用，但离职员工暂无可用账号且已登记“账号恢复后补发”意图时，
 * 必须像 NO_HANDLER 一样落持久的 not_launched 记录（读模型不再是 not_started），HR 看得到原因与处理入口；
 * 账号恢复后由补发在原记录上续发（不新建第二张单、不重复实例），HR 提前重提同样不重复。
 */
import './support/exit-gate-enforced.js';
import { getUser, setUserStatus, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as accounts from '../../apps/api/src/modules/employment/exit-account-worker.js';
import { handoverWorld } from './AC-EXIT-handover-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const round = (minute: number) => `2026-10-06T02:${String(minute).padStart(2, '0')}:00Z`;

async function world(label: string) {
  const x = await handoverWorld(database().db, `f310-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  await x.setTrigger({ enabled: true, includePastLastWorkDate: true });
  return x;
}
type World = Awaited<ReturnType<typeof world>>;

/** 已生效的离职申请（账号被自动停用）→ 改期替代；账号消费者暂停，账号保持停用且补发意图已登记。 */
async function waitingSuccessor(x: World) {
  const draft = await x.createdExit(x.employee.id, '2026-10-05', 'application', {
    exitTypeCode: 'voluntary',
    handoverEmployeeId: x.workOwner.employeeId,
  });
  const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} });
  expect(sent.status, await sent.clone().text()).toBe(200);
  await x.approveInReview(draft.id);
  const patch = {
    ifMatch: (await x.business(draft.id)).revision,
    idempotencyKey: crypto.randomUUID(),
    body: { lastWorkDate: '2026-10-20' },
  };
  const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
  try {
    const response = await x.session.request('PATCH', `/exits/${draft.id}`, patch);
    expect(response.status, await response.clone().text()).toBe(200);
    const { successor } = (await response.json()) as { successor: { id: string } };
    return successor.id;
  } finally {
    pause.mockRestore();
  }
}
const leaver = (x: World) => getUser(database().db, x.leaverUserId).then((user) => user!);
async function setStatus(x: World, status: 'active' | 'disabled') {
  const current = await leaver(x);
  await setUserStatus(database().db, { userId: current.id, status, expectedRevision: current.revision }, cmd());
}
const retryReceipts = (x: World, businessId: string) =>
  x.sqlRows<{ state: string; reason: string | null }>(sql`
    SELECT a.state, a.error_reason AS reason FROM employment_outbox_attempts a
    JOIN employment_outbox o ON o.tenant_id=a.tenant_id AND o.id=a.outbox_id
    WHERE o.tenant_id=${x.tenantId} AND o.business_id=${businessId}::uuid
      AND o.event_type='employment.exit_handover.retry' ORDER BY a.attempt_no`);

describe('F-310 / F-365 等账号补发的持久未发起记录', () => {
  it('F-310 等账号：落 not_launched 记录，读模型给出原因与提示，不再是 not_started', async () => {
    const x = await world('persist');
    const exitId = await waitingSuccessor(x);
    await setStatus(x, 'disabled');
    await x.runScheduler(round(5));
    const rows = await x.requestRows(exitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'not_launched', instanceId: null });
    const status = await x.statusOf(exitId);
    expect(status.status).toBe('not_launched');
    expect(status.request).toMatchObject({
      id: rows[0]!.id,
      notLaunchedReason: 'NO_INITIATOR_ACCOUNT',
      hint: expect.stringContaining('账号'),
      items: [],
    });
    // 补发意图仍在：同因等账号的回执不逐轮增长
    await x.runScheduler(round(10));
    expect(await retryReceipts(x, exitId)).toEqual([{ state: 'failed', reason: 'NO_INITIATOR_ACCOUNT' }]);
    expect(await x.requestRows(exitId)).toEqual(rows);
  });

  it('F-310 账号恢复：补发在原记录上续发为进行中，只有一张单、一个实例；再调度不重复', async () => {
    const x = await world('revive');
    const exitId = await waitingSuccessor(x);
    await setStatus(x, 'disabled');
    await x.runScheduler(round(5));
    const [waiting] = await x.requestRows(exitId);
    const before = await x.handoverInstanceCount();
    await setStatus(x, 'active');
    await x.runScheduler(round(10));
    const rows = await x.requestRows(exitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: waiting!.id, state: 'in_progress', initiatorUserId: x.leaverUserId });
    expect(rows[0]!.instanceId).not.toBeNull();
    expect(await x.handoverInstanceCount()).toBe(before + 1);
    const status = await x.statusOf(exitId);
    expect(status.status).toBe('in_progress');
    expect(status.request!.items.length).toBeGreaterThan(0);
    expect(await x.auditActions(waiting!.id, 'exit_handover.launch')).toHaveLength(1);
    expect((await retryReceipts(x, exitId)).at(-1)).toEqual({ state: 'sent', reason: null });
    await x.runScheduler(round(15));
    expect(await x.requestRows(exitId)).toEqual(rows);
    expect(await x.handoverInstanceCount()).toBe(before + 1);
  });

  it('F-310 HR 在账号恢复后先重提：原记录转进行中；随后的补发消费意图但不再新建实例', async () => {
    const x = await world('hr-first');
    const exitId = await waitingSuccessor(x);
    await setStatus(x, 'disabled');
    await x.runScheduler(round(5));
    const [waiting] = await x.requestRows(exitId);
    const before = await x.handoverInstanceCount();
    await setStatus(x, 'active');
    const request = (await x.statusOf(exitId)).request as unknown as { revision: number };
    const response = await x.session.request('POST', `/exit-handover-requests/${waiting!.id}/resubmit`, {
      ifMatch: request.revision,
      idempotencyKey: crypto.randomUUID(),
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await x.handoverInstanceCount()).toBe(before + 1);
    await x.runScheduler(round(10));
    const rows = await x.requestRows(exitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: waiting!.id, state: 'in_progress' });
    expect(await x.handoverInstanceCount()).toBe(before + 1);
    expect(await x.auditActions(waiting!.id, 'exit_handover.launch')).toHaveLength(0);
    expect(await x.auditActions(waiting!.id, 'exit_handover.resubmit')).toHaveLength(1);
    expect((await retryReceipts(x, exitId)).at(-1)?.state).toBe('sent');
  });
});
