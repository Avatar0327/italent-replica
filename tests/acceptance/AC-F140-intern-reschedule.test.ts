/** F-140b1 第 2 轮 P2-1：原单来源与 DEC-593 确认规则经真实 HR HTTP 延续到改期。 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { endWorld, type EndWorld } from './AC-INTERN-end-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';

const database = useTestDb();
const current = async (w: EndWorld, id: string) => (await w.session.request('GET', `/businesses/${id}`)).json();
const patch = async (w: EndWorld, id: string, lastWorkDate: string, extra: object = {}) =>
  w.session.request('PATCH', `/exits/${id}`, {
    ifMatch: (await current(w, id)).revision,
    body: { lastWorkDate, ...extra },
  });
async function fixture(label: string) {
  const w = await endWorld(database().db, `f140-intern-${label}`);
  const intern = await w.hire('合成改期实习生', 'intern');
  const applicationId = await w.applyRegularization(intern.employee.id, '2026-10-20');
  return { w, employeeId: intern.employee.id, applicationId };
}
async function unchanged(w: EndWorld, id: string) {
  return {
    business: await current(w, id),
    counts: await w.rows(sql`
      SELECT
        (SELECT count(*) FROM employment_payload_versions WHERE tenant_id=${w.tenantId}) AS payloads,
        (SELECT count(*) FROM employment_state_events WHERE tenant_id=${w.tenantId}) AS states,
        (SELECT count(*) FROM employment_activation_attempts WHERE tenant_id=${w.tenantId}) AS attempts,
        (SELECT count(*) FROM audit_events WHERE tenant_id=${w.tenantId}) AS audits,
        (SELECT count(*) FROM employment_outbox WHERE tenant_id=${w.tenantId}) AS events`),
  };
}
async function refused(response: Response, reason: string) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { details: { reason } } });
}

describe('AC-F140 第 2 轮 P2-1：结束实习改期沿用原单来源', () => {
  it('DEC-593 free_direct 改晚成功，转正申请到新计划生效时才作废', async () => {
    const { w, employeeId, applicationId } = await fixture('future');
    const leave = await w.terminateOk(employeeId, { endDate: '2026-10-25', confirmed: true });
    expect(leave.status).toBe('approved');
    const response = await patch(w, leave.id, '2026-10-26', { confirmed: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'approved', effectiveDate: '2026-10-27' });
    expect(await w.statusOf(applicationId)).toBe('in_review');
    const instance = (await w.instanceOf(applicationId))!;
    await w.runScheduler('2026-10-26T01:00:00Z');
    expect(await w.statusOf(leave.id)).toBe('approved');
    expect(await w.statusOf(applicationId)).toBe('in_review');
    expect(await w.pendingTasks(instance.id)).toHaveLength(1);
    expect(await w.audits(applicationId, 'employment.business.voided_by_exit')).toEqual([]);
    expect((await w.runScheduler('2026-10-27T01:00:00Z')).activated).toContain(leave.id);
    expect(await w.statusOf(applicationId)).toBe('voided');
    expect(await w.instanceOf(applicationId)).toMatchObject({ status: 'cancelled' });
    expect(await w.pendingTasks(instance.id)).toEqual([]);
    expect(await w.outboxCount(applicationId, 'employment.business.voided_by_exit')).toBe(1);
  });

  it('DEC-593 改期缺 confirmed 仍需原确认文案，拒绝无写入，确认后可重提', async () => {
    const { w, employeeId, applicationId } = await fixture('confirmation');
    const leave = await w.terminateOk(employeeId, { endDate: '2026-10-25', confirmed: true });
    const before = await unchanged(w, leave.id);
    const response = await patch(w, leave.id, '2026-10-26');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        message: '此人有转正申请在审批中，结束实习将作废该申请，确定？',
        details: {
          reason: 'CONFIRMATION_REQUIRED',
          warnings: [{ reason: 'INTERN_REGULARIZATION_WILL_BE_VOIDED', businessId: applicationId }],
        },
      },
    });
    expect(await unchanged(w, leave.id)).toEqual(before);
    expect((await patch(w, leave.id, '2026-10-26', { confirmed: true })).status).toBe(200);
    expect(await w.statusOf(applicationId)).toBe('in_review');
  });

  it.each(['direct', 'application'])('普通离职 %s 改期仍被 §8B 拦截且无写入', async (mode) => {
    const { w, employeeId, applicationId } = await fixture(mode);
    await installExitSeeds(w.db, w.tenantId);
    const created = await w.session.request('POST', `/exits/employees/${employeeId}`, {
      ifMatch: await w.revision(employeeId),
      body: { mode, lastWorkDate: '2026-10-10', fields: {}, exit: { exitTypeCode: 'voluntary' } },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const leave = await created.json();
    const before = await unchanged(w, leave.id);
    await refused(await patch(w, leave.id, '2026-10-26', { confirmed: true }), 'EXIT_REGULARIZATION_IN_FLIGHT');
    expect(await unchanged(w, leave.id)).toEqual(before);
    expect(await w.statusOf(applicationId)).toBe('in_review');
  });

  it('free_direct 不豁免调动确认令牌：confirmed 不能代替 pendingTransferAck', async () => {
    const { w, employeeId } = await fixture('transfer-ack');
    const leave = await w.terminateOk(employeeId, { endDate: '2026-10-25', confirmed: true });
    const transfer = await w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-20', fields: { departmentId: w.other.id } },
      await w.revision(employeeId),
    );
    const submitted = await w.session.request('POST', `/businesses/${transfer.id}/submit`, {
      ifMatch: transfer.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const before = await unchanged(w, leave.id);
    const response = await patch(w, leave.id, '2026-10-26', { confirmed: true });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: { details: { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' } } });
    expect(await unchanged(w, leave.id)).toEqual(before);
    const retry = await patch(w, leave.id, '2026-10-26', {
      confirmed: true,
      pendingTransferAck: body.error.details.ackToken,
    });
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await w.statusOf(transfer.id)).toBe('in_review');
  });

  it('已批准转正被新结束日跨过时，确认也不能绕过既有结束实习校验', async () => {
    const { w, employeeId, applicationId } = await fixture('due');
    await w.approve(applicationId);
    expect(await w.statusOf(applicationId)).toBe('approved');
    const leave = await w.terminateOk(employeeId, { endDate: '2026-10-10', confirmed: true });
    const before = await unchanged(w, leave.id);
    await refused(
      await patch(w, leave.id, '2026-10-26', { confirmed: true }),
      'INTERN_REGULARIZATION_DUE_BEFORE_END_DATE',
    );
    expect(await unchanged(w, leave.id)).toEqual(before);
  });

  it('R6 当天立即生效仍沿用 free_direct，确认后同事务作废在途转正', async () => {
    const { w, employeeId, applicationId } = await fixture('immediate');
    const leave = await w.terminateOk(employeeId, { endDate: '2026-10-25', confirmed: true });
    const response = await patch(w, leave.id, '2026-09-30', { confirmed: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await w.statusOf(leave.id)).toBe('effective');
    expect(await w.statusOf(applicationId)).toBe('voided');
  });
});
