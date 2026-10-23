/** F-305 / DEC-674 幂等并发；AC-DM-01/02：F-302 R1 P3 的最终完成 / 撤销快照回归。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Downstream } from '../../apps/api/src/modules/employment/exit-downstream.js';
import { handoverWorld, type HandoverWorld } from './AC-EXIT-handover-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const itPg = process.env.TEST_DATABASE_URL ? it : it.skip;
async function queued(x: HandoverWorld, requests: readonly (() => Promise<Response>)[]) {
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
  const running: Promise<Response>[] = [];
  try {
    for (const [index, request] of requests.entries()) {
      running.push(request());
      await waitForBlocked(x.db, index + 1);
    }
  } finally {
    release();
    await holder;
  }
  return Promise.all(running);
}
async function world(label: string) {
  const x = await handoverWorld(database().db, `f305-pg-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  return x;
}

describe('AC-DM-01/02/07 真 PG 员工锁强制交错', () => {
  itPg.each(['complete_first', 'cancel_first'] as const)('F-302 R1 P3 %s 撤销快照与落库状态一致', async (order) => {
    const x = await world(order);
    const { exitId, request, instanceId } = await x.launched();
    for (let step = 0; step < 3; step++) expect((await x.decide(instanceId)).status).toBe(200);
    const task = (await x.pendingNode(instanceId))!;
    expect(task.nodeKey).toBe('hrbp_certificate');
    const finish = () =>
      x.api.request('POST', `/api/tenant/approval/tasks/${task.taskId}/approve`, {
        ...x.tenantAs(task.userId),
        ifMatch: task.revision,
        body: {},
      });
    const init = {
      ifMatch: (await x.business(exitId)).revision,
      idempotencyKey: randomUUID(),
      body: { reason: '合成并发撤销' },
    };
    const cancel = () => x.session.request('POST', `/exits/${exitId}/cancel`, init);
    const responses = await queued(x, order === 'complete_first' ? [finish, cancel] : [cancel, finish]);
    const [completed, cancelled] = order === 'complete_first' ? responses : [...responses].reverse();
    expect(cancelled!.status, await cancelled!.clone().text()).toBe(200);
    expect(completed!.status).toBe(order === 'complete_first' ? 200 : 409);
    const receipt = (await cancelled!.json()) as { downstream: Downstream };
    const handover = receipt.downstream.items.find((item) => item.kind === 'handover');
    expect(handover?.targets).toEqual([
      {
        type: 'exit-handover-request',
        id: request.id,
        detail: { stateBefore: order === 'complete_first' ? 'completed' : 'in_progress' },
      },
    ]);
    const [stored] = await x.sqlRows<{ downstream: Downstream }>(sql`SELECT downstream FROM exit_cancellations
      WHERE tenant_id=${x.tenantId} AND business_id=${exitId}::uuid`);
    expect(stored?.downstream).toEqual(receipt.downstream);
    expect(await x.requestRows(exitId)).toEqual([
      expect.objectContaining({
        id: request.id,
        state: order === 'complete_first' ? 'completed' : 'terminated',
        endReason: order === 'complete_first' ? null : 'exit_cancelled',
      }),
    ]);
    expect(await x.instanceStatus(instanceId)).toBe(order === 'complete_first' ? 'approved' : 'cancelled');
    expect(await x.pendingTasks(instanceId)).toEqual([]);
    expect((await x.business(exitId)).status).toBe('voided');
    expect(await (await cancel()).json()).toEqual(receipt);
  });

  itPg.each([true, false])('DEC-674 并发重新提交，同一命令=%s，不产生第二个新实例', async (sameCommand) => {
    const x = await world(`same-${sameCommand}`);
    const { exitId, request, instanceId } = await x.launched();
    expect((await x.decide(instanceId, 'disagree')).status).toBe(200);
    const status = await x.statusOf(exitId);
    const revision = (status.request as unknown as { revision: number }).revision;
    const first = { ifMatch: revision, idempotencyKey: randomUUID(), body: {} };
    const second = sameCommand ? first : { ...first, idempotencyKey: randomUUID() };
    const path = `/exit-handover-requests/${request.id}/resubmit`;
    const [a, b] = await queued(x, [
      () => x.session.request('POST', path, first),
      () => x.session.request('POST', path, second),
    ]);
    expect(a!.status).toBe(200);
    expect(b!.status).toBe(sameCommand ? 200 : 409);
    const aBody = await a!.json();
    const bBody = await b!.json();
    if (sameCommand) expect(bBody).toEqual(aBody);
    else expect(bBody).toMatchObject({ error: { details: { reason: 'EXIT_HANDOVER_NOT_RESUBMITTABLE' } } });
    expect(await x.handoverInstanceCount()).toBe(2);
    expect(await x.requestRows(exitId)).toHaveLength(1);
    expect(await x.auditActions(request.id, 'exit_handover.resubmit')).toHaveLength(1);
  });
});
