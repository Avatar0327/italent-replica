/**
 * R2-T03 B3-3 / AC-DM-12、13、20、32：§18.1 五个关口拆除后，离职经公开入口走完整生效（B-80 的反向断言）。
 * ② 审批通过、③ 直接离职保存、① 调度 / HR 待办、④ HR 重试与 activate 端口；⑤ dutyTransfer 见 AC-EXIT-open-duty。
 * 另覆盖 B-02a、B-09 和 B3-2 遗留的 HR 待办端到端（EXIT_APPLICATIONS_TOO_MANY → 待办 → 处理后重试）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { AppError } from '../../apps/api/src/errors.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);

describe('AC-DM-32 B-80 反向：关口拆除后同样输入走完整生效', () => {
  it('③ 直接离职 L 已过：保存事务内生效，前一条止于 L，状态 8，合同终止、在途调动作废，台账含 confirmed 与 effective', async () => {
    const x = await world('open-direct');
    const labor = await x.contractType('劳动合同');
    const contract = await x.createContract(labor);
    const review = await x.transferIn('in_review', '2026-10-20');

    // 审批中的调动要先确认“生效时将作废”（§8）：第一次保存 409 给出令牌，带令牌重提才保存并生效
    const unconfirmed = await x.reason(await x.createLeave(x.employee.id, leaveBody('2026-10-05', 'direct')));
    expect(unconfirmed).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    const created = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-05', 'direct', { pendingTransferAck: unconfirmed.ackToken }),
    );

    expect(created.status).toBe('effective');
    expect((await x.business(created.id)).revision).toBe(created.revision);
    expect((await x.timeline()).map((row) => [row.kind, row.start_date, row.valid])).toEqual([
      ['hire', '2026-09-01', '[2026-09-01,2026-10-06)'],
      ['leave', TODAY, '[2026-10-06,)'],
    ]);
    expect(
      (
        await x.sqlRows<{ s: number }>(sql`SELECT employee_status AS s FROM employment_records
        WHERE id=${created.id}::uuid`)
      )[0]!.s,
    ).toBe(8);
    expect((await x.contractRows()).find((row) => row.id === contract.id)).toMatchObject({
      status: 'terminated',
      actual: '2026-10-05',
    });
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    expect((await x.effects(created.id)).map((row) => [row.phase, row.kind]).sort()).toEqual(
      [
        ['confirmed', 'establishment_pre_released'],
        ['effective', 'application_voided'],
        ['effective', 'contract_terminated'],
        ['effective', 'establishment_pre_released'],
      ].sort(),
    );
    // 保存当场生效成功不记生效尝试（与审批落地同口径），也不进 HR 待办
    expect(await x.attempts(created.id)).toEqual([]);
    expect(await x.todos()).toEqual([]);
  });

  it('② 审批通过且 E ≤ 今天：审批事务内生效（B-04 不算迟到），审批响应已是 effective', async () => {
    const x = await world('open-approve');
    const labor = await x.contractType('劳动合同');
    const contract = await x.createContract(labor);
    const draft = await x.submittedLeave('2026-10-05');

    const approved = await x.approve(draft, `${TODAY}T02:00:00Z`);

    expect(approved.status).toBe('effective');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'leave']);
    expect(await x.versions(draft.id)).toHaveLength(1);
    expect((await x.contractRows()).find((row) => row.id === contract.id)).toMatchObject({ actual: '2026-10-05' });
    expect((await x.effects(draft.id)).map((row) => row.phase)).toContain('effective');
    expect((await x.audits(draft.id, 'employment.exit.effective'))[0]!.after).toMatchObject({ source: 'approval' });
    expect(await x.attempts(draft.id)).toEqual([]);
  });

  it('② 审批通过但前序调动尚未执行：停在 approved、不记尝试，交调度按队列推进（调动先、离职后）', async () => {
    const x = await world('open-approve-pending');
    const transfer = await x.transferIn('approved', '2026-10-07');
    const draft = await x.submittedLeave('2026-10-07');
    await x.approve(draft, '2026-10-08T02:00:00Z');
    // 调动 T 计划 10-07 尚未被调度执行，离职 E = 10-08 排在其后
    expect(await x.stateOfBusiness(draft.id)).toBe('approved');
    expect(await x.attempts(draft.id)).toEqual([]);
    expect(await x.runScheduler('2026-10-08T03:00:00Z')).toMatchObject({ activated: [transfer.id, draft.id] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
  });

  it('① E 未到：审批后停在 approved，出现在待生效队列；调度到期当天原子生效（AC-DM-12 / B-03）', async () => {
    const x = await world('open-scheduler');
    const draft = await x.submittedLeave('2026-10-20');
    expect((await x.approve(draft, `${TODAY}T02:00:00Z`)).status).toBe('approved');
    expect(await x.attempts(draft.id)).toEqual([]);
    expect(await x.runScheduler('2026-10-20T01:00:00Z')).toMatchObject({ activated: [] });
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [draft.id], failed: [] });
    expect((await x.business(draft.id)).status).toBe('effective');
    expect((await x.attempts(draft.id)).map((row) => row.outcome)).toEqual(['effective']);
    expect((await x.timeline()).at(-1)).toMatchObject({ kind: 'leave', start_date: '2026-10-21' });
  });

  it('④ activate 端口：前序调动未执行 → 409 ACTIVATION_PREDECESSOR_PENDING，无写入', async () => {
    const x = await world('open-port');
    await x.transferIn('approved', '2026-10-07');
    const leave = await x.directLeave('2026-10-10');
    const revision = (await x.business(leave.id)).revision;
    const before = await x.stateOf(x.employee.id);
    await expect(
      runEmploymentTransition(
        x.db,
        {
          tenantId: x.session.tenant.id,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: new Date('2026-10-12T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: revision,
        },
        { id: leave.id, action: 'activate' },
      ),
    ).rejects.toMatchObject({ details: { reason: 'ACTIVATION_PREDECESSOR_PENDING' } });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });
});

describe('AC-DM-20 失败待办与重试端到端（B-02a、B-09、EXIT_APPLICATIONS_TOO_MANY）', () => {
  it('B-02a 到期下游失败：整单 failed、HR 待办出现该离职、时间轴 / 申请 / 合同不变；修正后 HR 重试成功，待办关闭', async () => {
    const x = await world('open-b02a');
    const labor = await x.contractType('劳动合同');
    const contract = await x.createContract(labor);
    const draft = await x.submittedLeave('2026-10-10');
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    const review = await x.transferIn('in_review', '2026-10-30');
    let fail = true;
    exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => {
      if (fail && event.businessId === draft.id)
        throw new AppError('CONFLICT', '后续任务失败', { reason: 'DOWNSTREAM_FAILED' });
    });
    const before = await x.stateOf(x.employee.id);

    expect(await x.runScheduler('2026-10-11T01:00:00Z')).toMatchObject({ failed: [draft.id], activated: [] });

    const after = await x.stateOf(x.employee.id);
    for (const key of ['timeline', 'contracts', 'instances', 'effects', 'approvalLogs'] as const)
      expect(after[key], key).toEqual(before[key]);
    expect(await x.stateOfBusiness(review.id)).toBe('in_review');
    expect(await x.todos()).toMatchObject([
      { id: draft.id, kind: 'leave', activation: { status: 'failed', failureReason: 'RULE_REJECTED' } },
    ]);
    fail = false;
    const retried = await x.retry(draft, '2026-10-11T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(draft.id)).toBe('effective');
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    expect((await x.contractRows()).find((row) => row.id === contract.id)).toMatchObject({ actual: '2026-10-10' });
    expect(await x.todos()).toEqual([]);
    expect((await x.attempts(draft.id)).map((row) => row.outcome)).toEqual(['failed', 'effective']);
  });

  it('HR 待办端到端：在途申请超过上限 → 生效失败 EXIT_APPLICATIONS_TOO_MANY → 待办 → 处理后重试成功', async () => {
    const x = await world('open-too-many');
    const draft = await x.submittedLeave('2026-10-10');
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    await x.bulkDrafts(1001);

    expect(await x.runScheduler('2026-10-11T01:00:00Z')).toMatchObject({ failed: [draft.id] });
    expect(await x.todos()).toMatchObject([
      { id: draft.id, kind: 'leave', activation: { status: 'failed', failureReason: 'EXIT_APPLICATIONS_TOO_MANY' } },
    ]);
    expect(await x.stateOfBusiness(draft.id)).toBe('approved');

    const [one] = await x.sqlRows<{ id: string }>(sql`SELECT business_id AS id FROM employment_state_events
      WHERE tenant_id=${x.session.tenant.id} AND command_id='bulk-draft' LIMIT 1`);
    await x.sqlRows(sql`INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,
        event_no,command_id)
      SELECT tenant_id,employee_id,business_id,payload_version_id,'deleted',2,'bulk-delete'
      FROM employment_state_events WHERE tenant_id=${x.session.tenant.id} AND business_id=${one!.id}::uuid`);
    const retried = await x.retry(draft, '2026-10-11T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(draft.id)).toBe('effective');
    expect(await x.todos()).toEqual([]);
    expect(await x.stateCounts()).toEqual([
      { state: 'deleted', n: 1 },
      { state: 'effective', n: expect.any(Number) },
      { state: 'voided', n: 1000 },
    ]);
  }, 600_000);

  it('B-09 前序调动到期失败（目标组织已停用）：离职挂起 PREDECESSOR_FAILED；修正后 HR 重试，调动与离职按序生效', async () => {
    const x = await world('open-b09');
    const transfer = await x.transferIn('approved', '2026-10-07');
    const draft = await x.submittedLeave('2026-10-15');
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    await seedLegacyOrgDeactivation(x, '2026-10-06');

    expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({
      failed: [transfer.id],
      suspended: [draft.id],
    });
    expect((await x.attempts(draft.id)).at(-1)).toMatchObject({
      outcome: 'suspended',
      reason: 'PREDECESSOR_FAILED',
      blocked_by_business_id: transfer.id,
    });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    // 待办两条：T 生效失败，离职因前序失败挂起（§10.1）
    expect((await x.todos()).map((todo) => todo.id)).toEqual([transfer.id, draft.id]);

    await seedLegacyOrgDeactivation(x, '2026-10-08', x.to, true);
    const retried = await x.retry(transfer, '2026-10-16T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
    expect(await x.todos()).toEqual([]);
  });
});

describe('AC-DM-32 B4 前撤销仍不可用（§18.1 末段）', () => {
  it('approved 离职的通用 DELETE / revoke 409 EXIT_OPERATION_NOT_AVAILABLE，无写入；已生效的同样', async () => {
    const x = await world('open-cancel-closed');
    const direct = await x.createdLeave(x.employee.id, leaveBody('2026-10-20', 'direct'));
    const before = await x.stateOf(x.employee.id);
    const removed = await x.session.request('DELETE', `/businesses/${direct.id}`, { ifMatch: direct.revision });
    expect(await x.reason(removed)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    const revoked = await x.session.request('POST', `/businesses/${direct.id}/revoke`, {
      ifMatch: direct.revision,
      body: {},
    });
    expect(await x.reason(revoked)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [direct.id] });
    const effective = await x.business(direct.id);
    const afterEffective = await x.stateOf(x.employee.id);
    const removedEffective = await x.session.request('DELETE', `/businesses/${direct.id}`, {
      ifMatch: effective.revision,
    });
    expect(await x.reason(removedEffective)).toMatchObject({ status: 409, reason: 'EXIT_OPERATION_NOT_AVAILABLE' });
    expect(await x.stateOf(x.employee.id)).toEqual(afterEffective);
  });
});
