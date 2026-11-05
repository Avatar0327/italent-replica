/** B4（F-310 / F-350 / F-368）共用夹具：改期替代 + 暂停账号消费者，制造“账号待恢复、补发意图已登记”的后继单。 */
import { getUser, setUserStatus, sql } from '@italent/db';
import { expect, vi } from 'vitest';
import * as accounts from '../../apps/api/src/modules/employment/exit-account-worker.js';
import { handoverWorld } from './AC-EXIT-handover-support.js';
import { cmd } from './support/tenant-api.js';

export const round = (minute: number) => `2026-10-06T02:${String(minute).padStart(2, '0')}:00Z`;

export async function f310World(db: Parameters<typeof handoverWorld>[0], label: string) {
  const x = await handoverWorld(db, `f310-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  await x.setTrigger({ enabled: true, includePastLastWorkDate: true });
  return x;
}
export type F310World = Awaited<ReturnType<typeof f310World>>;

/**
 * 已生效的离职申请（账号被自动停用）→ 改期替代，返回后继离职单 ID。
 * pauseAccounts 为真时账号消费者暂停：账号保持停用，补发意图已登记；为假时同一请求内恢复账号并立即补发。
 */
export async function replacedSuccessor(x: F310World, pauseAccounts = true) {
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
  const pause = pauseAccounts ? vi.spyOn(accounts, 'drainExitAccounts').mockResolvedValue() : null;
  try {
    const response = await x.session.request('PATCH', `/exits/${draft.id}`, patch);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { successor: { id: string } }).successor.id;
  } finally {
    pause?.mockRestore();
  }
}

export async function setLeaverStatus(x: F310World, status: 'active' | 'disabled') {
  const current = (await getUser(x.db, x.leaverUserId))!;
  await setUserStatus(x.db, { userId: current.id, status, expectedRevision: current.revision }, cmd());
}

/** 后继单补发意图的全部回执（按次数）。 */
export const retryReceipts = (x: F310World, businessId: string) =>
  x.sqlRows<{ state: string; reason: string | null }>(sql`
    SELECT a.state, a.error_reason AS reason FROM employment_outbox_attempts a
    JOIN employment_outbox o ON o.tenant_id=a.tenant_id AND o.id=a.outbox_id
    WHERE o.tenant_id=${x.tenantId} AND o.business_id=${businessId}::uuid
      AND o.event_type='employment.exit_handover.retry' ORDER BY a.attempt_no`);
