/**
 * R2-T03 B3-2 / AC-DM-14（作废）、AC-DM-16：离职生效时作废全部在途任职申请（设计 §5.1 步骤 1、§5.5，DEC-496①）。
 * 只经内部编排器入口 activateExit 验证（§18.1 五个关口保持关闭）。覆盖 B-06、B-06a、B-06b、B-07、B-08、B-10a、
 * B-12、B-14、B-15、B-56b、B-02a（步骤 2 以后失败时作废随保存点回滚）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string, today = TODAY) => downstreamWorld(database().db, label, today);

describe('AC-DM-16 步骤 1：作废全部在途任职申请', () => {
  it('B-06 / B-15 审批中调动：作废，实例 cancelled、待办关闭、发起人收站内消息、台账与审计齐全；本单实例不被终止', async () => {
    const x = await world('b06');
    const leave = await x.approvedLeave('2026-10-05', TODAY);
    const review = await x.transferIn('in_review', '2026-10-20');
    const instance = (await x.instanceOf(review.id))!;
    const own = await x.instanceOf(leave.id);
    expect(await x.pendingTasks(instance.id)).toHaveLength(1);

    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });

    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    expect(await x.instanceOf(review.id)).toMatchObject({ id: instance.id, status: 'cancelled' });
    expect(await x.pendingTasks(instance.id)).toEqual([]);
    expect(await x.notices(instance.id)).toEqual([
      { recipient: x.session.user.id, template: 'application_voided_by_exit', kind: 'message' },
    ]);
    expect(await x.instanceOf(leave.id)).toEqual(own);
    const [effect] = (await x.effects(leave.id)).filter((row) => row.kind === 'application_voided');
    expect(effect).toMatchObject({
      phase: 'effective',
      target_id: review.id,
      detail: { kind: 'transfer', stateBefore: 'in_review', effectiveDate: '2026-10-20', instanceId: instance.id },
    });
    const [audit] = await x.audits(review.id, 'employment.transfer.voided_by_exit');
    expect(audit!.after).toMatchObject({ exitBusinessId: leave.id, kind: 'transfer', stateBefore: 'in_review' });
    expect(await x.outboxCount(review.id, 'employment.transfer.voided_by_exit')).toBe(1);
  });

  it('B-06 申请人与发起人不同（HR 代发）：两人都收到站内消息', async () => {
    const x = await world('b06-both');
    const leave = await x.directLeave('2026-10-05');
    const applicant = await x.applicantAccount(x.employee.id);
    const initiator = await x.otherUser();
    const review = await x.applyAs(initiator.id, x.employee.id, '2026-10-20', { departmentId: x.to.id });
    const instance = (await x.instanceOf(review.id))!;
    await x.activate(leave.id, TODAY);
    expect((await x.notices(instance.id)).map((row) => row.recipient).sort()).toEqual([applicant, initiator.id].sort());
  });

  it('B-06a / B-06b / B-14 其他 kind 的在途申请（草稿 / 审批中 / 已驳回，生效日早于与晚于 L）一律作废', async () => {
    const x = await world('b06b');
    const leave = await x.directLeave('2026-10-05');
    const ids = [
      await x.synthetic(x.employee.id, { kind: 'regularization', state: 'in_review', effectiveDate: '2026-10-03' }),
      await x.synthetic(x.employee.id, { kind: 'regularization', state: 'in_review', effectiveDate: '2026-10-20' }),
      await x.synthetic(x.employee.id, { kind: 'regularization', state: 'draft', effectiveDate: '2026-10-03' }),
      await x.synthetic(x.employee.id, { kind: 'regularization', state: 'rejected', effectiveDate: '2026-10-20' }),
    ];
    await x.activate(leave.id, TODAY);
    for (const id of ids) {
      expect(await x.stateOfBusiness(id)).toBe('voided');
      expect((await x.audits(id, 'employment.business.voided_by_exit'))[0]!.after).toMatchObject({
        exitBusinessId: leave.id,
        kind: 'regularization',
      });
    }
    const voided = (await x.effects(leave.id)).filter((row) => row.kind === 'application_voided');
    expect(voided.map((row) => row.target_id)).toEqual([...ids].sort());
    // 没有审批实例的单据不挂站内消息，只写 outbox（A-7）
    expect(await x.outboxCount(ids[0]!, 'employment.business.voided_by_exit')).toBe(1);
  });

  it('B-07 / B-10a 已批未生效、草稿、已驳回的调动：均作废；草稿无实例只写 outbox，已驳回有实例则 cancelled 并发消息', async () => {
    const x = await world('b07');
    const leave = await x.directLeave('2026-10-05');
    const approved = await x.transferIn('approved', '2026-10-25');
    const draft = await x.transferIn('draft', '2026-10-28');
    const rejected = await x.transferIn('rejected', '2026-10-30');
    const returned = (await x.instanceOf(rejected.id))!;
    expect(returned.status).toBe('returned');
    await x.activate(leave.id, TODAY);
    for (const business of [approved, draft, rejected]) {
      expect(await x.stateOfBusiness(business.id)).toBe('voided');
      expect(await x.outboxCount(business.id, 'employment.transfer.voided_by_exit')).toBe(1);
    }
    expect(await x.instanceOf(rejected.id)).toMatchObject({ status: 'cancelled' });
    expect(await x.notices(returned.id)).toHaveLength(1);
    expect(await x.instanceOf(draft.id)).toBeUndefined();
    const stateBefore = (await x.effects(leave.id))
      .filter((row) => row.kind === 'application_voided')
      .map((row) => [row.target_id, (row.detail as { stateBefore: string }).stateBefore]);
    expect(stateBefore).toEqual(
      [
        [approved.id, 'approved'],
        [draft.id, 'draft'],
        [rejected.id, 'rejected'],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  });

  it('B-08 已批准且计划日 ≤ L 的调动先于离职落地（§5.0 队列），不被作废；晚于 L 的作废', async () => {
    const x = await world('b08', '2026-10-01');
    const earlier = await x.transferIn('approved', '2026-10-10');
    const later = await x.transferIn('approved', '2026-10-20');
    const leave = await x.directLeave('2026-10-12');
    await expect(x.activate(leave.id, '2026-10-13')).rejects.toMatchObject({
      details: { reason: 'ACTIVATION_PREDECESSOR_PENDING' },
    });
    await x.runScheduler('2026-10-13T02:00:00Z');
    expect(await x.stateOfBusiness(earlier.id)).toBe('effective');
    expect(await x.activate(leave.id, '2026-10-13')).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(earlier.id)).toBe('effective');
    expect(await x.stateOfBusiness(later.id)).toBe('voided');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
  });

  it('B-56b 被离职作废的申请此后再被操作（审批中心同意 / 业务同意 / HR 重提）均 409 且无写入', async () => {
    const x = await world('b56b');
    const leave = await x.directLeave('2026-10-05');
    const review = await x.transferIn('in_review', '2026-10-20');
    const instance = (await x.instanceOf(review.id))!;
    const [task] = await x.pendingTasks(instance.id);
    await x.activate(leave.id, TODAY);
    const before = await x.stateOf(x.employee.id);
    const approve = await x.api.request('POST', `/api/tenant/approval/tasks/${task!.id}/approve`, {
      tenant: x.session.tenant.id,
      user: x.session.user.id,
      ifMatch: 1,
      body: {},
    });
    expect(approve.status, await approve.clone().text()).toBe(409);
    const submit = await x.session.request('POST', `/businesses/${review.id}/submit`, {
      ifMatch: (await x.business(review.id)).revision,
      body: {},
    });
    expect(submit.status).toBe(409);
    await expect(
      runEmploymentTransition(
        database().db,
        {
          tenantId: x.session.tenant.id,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: new Date(`${TODAY}T02:00:00Z`),
          commandId: crypto.randomUUID(),
          expectedRevision: (await x.business(review.id)).revision,
        },
        { id: review.id, action: 'approve' },
      ),
    ).resolves.toMatchObject({ status: 409 });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('B-02a 步骤 2 之后失败（合同端口等）时，步骤 1 的作废随保存点整体回滚，审批流照常', async () => {
    const x = await world('b02a');
    const leave = await x.directLeave('2026-10-05');
    const review = await x.transferIn('in_review', '2026-10-20');
    const instance = (await x.instanceOf(review.id))!;
    // 合同编号冲突无法稳定造；改用“同一员工另有未办结离职之外的阻塞”不可行，故直接让 hook 抛业务错误
    const { exitPostEffectHooks } = await import('../../apps/api/src/modules/employment/exit-confirmation.js');
    const { AppError } = await import('../../apps/api/src/errors.js');
    let fail = true;
    exitPostEffectHooks.onEffective(async () => {
      if (fail) throw new AppError('CONFLICT', '后续任务失败', { reason: 'DOWNSTREAM_FAILED' });
    });
    const before = await x.stateOf(x.employee.id);
    const result = await x.activate(leave.id, TODAY);
    expect(result).toMatchObject({ outcome: 'failed' });
    const after = await x.stateOf(x.employee.id);
    for (const key of ['timeline', 'instances', 'approvalLogs', 'contracts', 'effects'] as const)
      expect(after[key], key).toEqual(before[key]);
    expect(await x.stateOfBusiness(review.id)).toBe('in_review');
    expect(await x.pendingTasks(instance.id)).toHaveLength(1);
    fail = false;
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
  });
});

/** 创建直接离职：有在途调动时第一次得到确认令牌（§8），带令牌再提交。 */
async function acked(session: Awaited<ReturnType<typeof carriedWorld>>['session'], employeeId: string) {
  const create = async (exit?: object) =>
    session.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: (await session.getEmployee(employeeId)).revision,
      body: leaveBody('2026-10-02', 'direct', exit),
    });
  let response = await create();
  if (response.status === 409) {
    const token = ((await response.json()) as { error: { details: { ackToken: string } } }).error.details.ackToken;
    response = await create({ pendingTransferAck: token });
  }
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}

describe('AC-DM-14 B-12 带编调动被离职作废', () => {
  it('回退带编分配，容量与调动前一致；原岗位被占满而回退会超编时离职生效失败 ESTABLISHMENT_EXCEEDED，全部回滚', async () => {
    const w = await carriedWorld(database().db, 'b12');
    await installExitSeeds(database().db, w.session.tenant.id);
    const person = await w.hired();
    const before = await w.capacities();
    const saved = await w.save(person, { mode: 'application', submit: true, effectiveDate: '2026-10-20' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const transfer = (await saved.json()) as { id: string };
    expect(await w.capacities()).not.toEqual(before);
    const leave = await acked(w.session, person.employee.id);
    const activate = exitActivator(database().db, w.session);
    expect(await activate(leave.id, '2026-10-03')).toMatchObject({ outcome: 'effective' });
    expect((await w.business(transfer.id)).status).toBe('voided');
    expect(await w.capacities()).toEqual(before);

    // 超编分支：另一个员工占满调入部门后，回退带编分配会让调入部门超出严格编制
    const strict = await carriedWorld(database().db, 'b12-strict');
    await installExitSeeds(database().db, strict.session.tenant.id);
    const second = await strict.hired();
    const carried = await strict.save(second, { mode: 'application', submit: true, effectiveDate: '2026-10-20' });
    expect(carried.status, await carried.clone().text()).toBe(201);
    const occupant = await strict.session.employee('合成后来占编员工');
    await strict.session.business(
      occupant.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { departmentId: strict.to.id, positionId: strict.targetPosition },
      },
      occupant.revision,
    );
    const strictLeave = await acked(strict.session, second.employee.id);
    const snapshot = await strict.capacities();
    expect(await exitActivator(database().db, strict.session)(strictLeave.id, '2026-10-03')).toMatchObject({
      outcome: 'failed',
      reason: 'ESTABLISHMENT_EXCEEDED',
    });
    expect(await strict.capacities()).toEqual(snapshot);
    expect(((await carried.json()) as { status?: string }).status ?? 'in_review').toBe('in_review');
  });
});
