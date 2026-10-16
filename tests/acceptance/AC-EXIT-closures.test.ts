/**
 * R2-T03 B2a / AC-DM-32 B-80：B2a 合并后到 B3-3 合并前的“只允许审批、禁止离职生效”五个关口（设计 §18.1）。
 * 五例各读前后的时间轴、合同、调动申请、审批实例（stateOf 逐项相等）：
 * ① 调度 / HR 待办队列看不到离职；② 审批通过且 E ≤ 今天停在 approved；③ 直接离职 L 已过也只存 approved；
 * ④ 重试与通用 activate 409 EXIT_ACTIVATION_NOT_AVAILABLE；⑤ dutyTransfer 400 EXIT_DUTY_TRANSFER_NOT_AVAILABLE。
 * 另：approved / effective 离职的通用 DELETE / revoke 在 B4 前一律 409 EXIT_OPERATION_NOT_AVAILABLE。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { queueContext } from './AC-EXIT-queue-support.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';

async function world(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee } = await w.hired();
  return { w, employee };
}

describe('AC-DM-32 B-80 §18.1 五个关口（B3-3 前离职一律不落地）', () => {
  it('③ 直接离职 L 已过：保存为 approved，时间轴 / 合同 / 调动申请不变，无生效尝试', async () => {
    const { w, employee } = await world('closure-direct');
    const before = await w.stateOf(employee.id);
    const created = await w.createdLeave(employee.id, leaveBody('2026-10-01', 'direct'));
    expect(created.status).toBe('approved');
    const after = await w.stateOf(employee.id);
    expect({ ...after, businesses: before.businesses, exits: before.exits, outbox: before.outbox }).toEqual(before);
    expect((await w.session.records(employee.id, '2026-10-10')).map((r) => r.kind)).toEqual(['hire']);
    expect(await w.exitRow(created.id)).toMatchObject({ mode: 'direct', initiator: 'hr', pre_release_date: null });
  });

  it('② 审批通过且 E ≤ 今天：停在 approved，不落地、不记生效尝试；① 调度运行后仍 approved 且不在队列', async () => {
    const { w, employee } = await world('closure-approve');
    const draft = await w.createdLeave(
      employee.id,
      leaveBody('2026-10-01', 'application', { exitTypeCode: 'voluntary' }),
    );
    const sent = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status).toBe(200);
    const before = await w.stateOf(employee.id);
    expect(await w.approve(draft, `${TODAY}T02:00:00Z`)).toMatchObject({ status: 'approved' });
    const after = await w.stateOf(employee.id);
    expect({ timeline: after.timeline, contracts: after.contracts, attempts: after.attempts }).toEqual({
      timeline: before.timeline,
      contracts: before.contracts,
      attempts: before.attempts,
    });
    const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
      pendingActivations(tx, queueContext(w, '2026-10-18'), employee.id),
    );
    expect(queue).toEqual([]);
    expect(await w.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [], failed: [], suspended: [] });
    const final = await w.stateOf(employee.id);
    expect({ timeline: final.timeline, attempts: final.attempts }).toEqual({
      timeline: before.timeline,
      attempts: before.attempts,
    });
    expect((await w.business(draft.id)).status).toBe('approved');
  });

  it('④ HR 重试与通用 activate 端口对离职 409 EXIT_ACTIVATION_NOT_AVAILABLE，无写入', async () => {
    const { w, employee } = await world('closure-activate');
    const direct = await w.createdLeave(employee.id, leaveBody('2026-10-01', 'direct'));
    const before = await w.stateOf(employee.id);
    const retry = await w.session.request('POST', `/businesses/${direct.id}/activation/retry`, {
      ifMatch: direct.revision,
      body: {},
    });
    expect(await w.reason(retry)).toMatchObject({ status: 409, reason: 'EXIT_ACTIVATION_NOT_AVAILABLE' });
    await expect(
      runEmploymentTransition(
        w.db,
        {
          tenantId: w.session.tenant.id,
          userId: w.session.user.id,
          timezone: w.session.tenant.timezone,
          now: new Date('2026-10-18T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: direct.revision,
        },
        { id: direct.id, action: 'activate' },
      ),
    ).rejects.toMatchObject({ details: { reason: 'EXIT_ACTIVATION_NOT_AVAILABLE' } });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });

  it('⑤ 携带 dutyTransfer 的离职请求 400 EXIT_DUTY_TRANSFER_NOT_AVAILABLE，无写入', async () => {
    const { w, employee } = await world('closure-duty');
    const before = await w.stateOf(employee.id);
    const body = leaveBody('2026-10-20', 'application', { dutyTransfer: { subordinates: [], orgRoles: [] } });
    const rejected = await w.createLeave(employee.id, body);
    expect(await w.reason(rejected)).toMatchObject({ status: 400, reason: 'EXIT_DUTY_TRANSFER_NOT_AVAILABLE' });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });

  it('B4 前 approved 离职的通用 DELETE / revoke 409 EXIT_OPERATION_NOT_AVAILABLE，无写入', async () => {
    const { w, employee } = await world('closure-cancel');
    const direct = await w.createdLeave(employee.id, leaveBody('2026-10-20', 'direct'));
    const before = await w.stateOf(employee.id);
    const removed = await w.session.request('DELETE', `/businesses/${direct.id}`, { ifMatch: direct.revision });
    expect(await w.reason(removed)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    const revoked = await w.session.request('POST', `/businesses/${direct.id}/revoke`, {
      ifMatch: direct.revision,
      body: {},
    });
    expect(await w.reason(revoked)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    expect(await w.stateOf(employee.id)).toEqual(before);
  });
});
