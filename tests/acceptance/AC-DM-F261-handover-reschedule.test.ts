/** AC-DM-05 × DM-R14：F-140b 替代、F-261 账号恢复与 BE-8b 交接发起的相交回归。 */
import './support/exit-gate-enforced.js';
import { getUser, setUserStatus } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import * as accounts from '../../apps/api/src/modules/employment/exit-account-worker.js';
import { handoverWorld } from './AC-EXIT-handover-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
async function setup(label: string, lastWorkDate = '2026-10-05') {
  const x = await handoverWorld(database().db, `f261-handover-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  await x.setTrigger({ enabled: true, includePastLastWorkDate: true });
  const draft = await x.createdExit(x.employee.id, lastWorkDate, 'application', {
    exitTypeCode: 'voluntary',
    handoverEmployeeId: x.workOwner.employeeId,
  });
  const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
  await x.approveInReview(draft.id);
  const old = await x.requestRows(draft.id);
  expect(old).toHaveLength(1);
  expect(old[0]!.state).toBe('in_progress');
  const patch = {
    ifMatch: (await x.business(draft.id)).revision,
    idempotencyKey: crypto.randomUUID(),
    body: { lastWorkDate: '2026-10-20' },
  };
  const replace = async () => {
    const response = await x.session.request('PATCH', `/exits/${draft.id}`, patch);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { successor: { id: string; status: string; effectiveDate: string } };
  };
  const user = async () => (await getUser(database().db, x.leaverUserId))!;
  return { x, draft, old: old[0]!, replace, user };
}

it('AC-DM-05 × DM-R14：未生效改期保留原交接，账号保持 active', async () => {
  const { x, draft, old, replace, user } = await setup('approved', '2026-10-10');
  await replace();
  expect(await x.requestRows(draft.id)).toEqual([old]);
  expect((await user()).status).toBe('active');
});

it('AC-DM-05 × DM-R14：已生效改到未来，恢复账号并发起唯一后继交接；命令重放和调度均不多发', async () => {
  const { x, draft, replace, user } = await setup('replacement');
  expect((await x.business(draft.id)).status).toBe('effective');
  const disabled = await user();
  expect(disabled.status).toBe('disabled');
  const result = await replace();
  expect(result.successor).toMatchObject({ status: 'approved', effectiveDate: '2026-10-21' });
  expect((await x.requestRows(draft.id))[0]).toMatchObject({ state: 'terminated', endReason: 'exit_cancelled' });
  const restored = await user();
  expect(restored.status).toBe('active');
  expect(restored.revision).toBe(disabled.revision + 1);
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ state: 'in_progress', initiatorUserId: x.leaverUserId });
  expect((await x.statusOf(result.successor.id)).status).toBe('in_progress');
  expect(await replace()).toEqual(result);
  await x.runScheduler('2026-10-06T02:05:00Z');
  await x.runScheduler('2026-10-06T02:10:00Z');
  expect(await x.requestRows(result.successor.id)).toEqual(next);
  expect(await x.auditActions(next[0]!.id, 'exit_handover.launch')).toHaveLength(1);
  expect(await user()).toEqual(restored);
});

it('AC-DM-05 × DM-R14：提交后消费者未运行，后续调度恢复账号并补发，重复调度不多发', async () => {
  const { x, replace, user } = await setup('recovery');
  const pause = vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue();
  let result: Awaited<ReturnType<typeof replace>>;
  try {
    result = await replace();
    expect((await user()).status).toBe('disabled');
    expect(await x.requestRows(result.successor.id)).toEqual([]);
  } finally {
    pause.mockRestore();
  }
  await x.runScheduler('2026-10-06T02:05:00Z');
  const restored = await user();
  expect(restored.status).toBe('active');
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.state).toBe('in_progress');
  await x.runScheduler('2026-10-06T02:10:00Z');
  expect(await x.requestRows(result.successor.id)).toEqual(next);
  expect(await user()).toEqual(restored);
  expect(await x.auditActions(next[0]!.id, 'exit_handover.launch')).toHaveLength(1);
});

it('AC-DM-05 × DM-R14：因果对照，替代前账号已恢复时正常发起后继交接', async () => {
  const { x, draft, replace, user } = await setup('control');
  const disabled = await user();
  expect(disabled.status).toBe('disabled');
  await setUserStatus(
    database().db,
    { userId: disabled.id, status: 'active', expectedRevision: disabled.revision },
    cmd(),
  );
  const result = await replace();
  expect((await x.requestRows(draft.id))[0]!.state).toBe('terminated');
  const next = await x.requestRows(result.successor.id);
  expect(next).toHaveLength(1);
  expect(next[0]!.state).toBe('in_progress');
});
