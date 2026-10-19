/**
 * R2-T03 B4 / AC-DM-01、02：撤销离职四种情况（设计 §7.1）与撤销清单（§7.4）、被作废申请的状态（§7.5）。
 * 覆盖 B-19、B-20、B-22、B-60a、B-17（撤销清单含职责转交已执行）、B-85a/b（撤销入口）。
 * 区间变化统一校验（§6B）见 AC-EXIT-cancel-intervals；通用入口映射 / restore / 撤销记录修改见 AC-EXIT-cancel-entries。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cancelWorld, type CancelWorld } from './AC-EXIT-cancel-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => cancelWorld(database().db, label, TODAY);

/** 撤销清单固定四类，顺序固定；未接入的类目以 not_connected 占位。其后追加已登记的探针类目（兼职 PT-6b：part-time）。 */
const FIXED = ['contract', 'duty_transfer', 'handover', 'payroll', 'part-time'];
const kinds = (result: { downstream: { items: { kind: string }[] } }) => result.downstream.items.map((i) => i.kind);
const item = (result: Awaited<ReturnType<CancelWorld['cancelled']>>, kind: string) =>
  result.downstream.items.find((entry) => entry.kind === kind)!;

describe('AC-DM-01 撤销未办结的离职（process_voided）', () => {
  it('草稿：状态置删除，撤销记录 / 审计落库，时间轴不变', async () => {
    const x = await world('cancel-draft');
    const draft = await x.createdLeave(x.employee.id, leaveBody('2026-10-20', 'application'));

    const result = await x.cancelled(draft.id, { reason: '  录入有误  ' });

    expect(result).toMatchObject({
      id: draft.id,
      status: 'deleted',
      cancellation: { case: 'process_voided', stateBefore: 'draft', reason: '录入有误', revision: 1 },
    });
    expect(await x.stateOfBusiness(draft.id)).toBe('deleted');
    expect(await x.cancellationOf(draft.id)).toMatchObject({ case: 'process_voided', stateBefore: 'draft' });
    expect(await x.auditActions(draft.id)).toContain('exit.request.cancel');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(kinds(result)).toEqual(FIXED);
  });

  it('审批中：业务作废、审批实例取消、待办关闭', async () => {
    const x = await world('cancel-in-review');
    const draft = await x.submittedLeave('2026-10-20');
    const instance = (await x.instanceOf(draft.id))!;
    expect((await x.pendingTasks(instance.id)).length).toBeGreaterThan(0);

    const result = await x.cancelled(draft.id);

    expect(result).toMatchObject({
      status: 'voided',
      cancellation: { case: 'process_voided', stateBefore: 'in_review' },
    });
    expect((await x.instanceOf(draft.id))!.status).toBe('cancelled');
    expect(await x.pendingTasks(instance.id)).toEqual([]);
  });

  it('已驳回：业务作废、退回中的实例取消', async () => {
    const x = await world('cancel-rejected');
    const draft = await x.submittedLeave('2026-10-20');
    await x.rejectInReview(draft.id);
    expect(await x.stateOfBusiness(draft.id)).toBe('rejected');

    const result = await x.cancelled(draft.id);

    expect(result).toMatchObject({
      status: 'voided',
      cancellation: { case: 'process_voided', stateBefore: 'rejected' },
    });
    expect((await x.instanceOf(draft.id))!.status).toBe('cancelled');
  });
});

describe('AC-DM-02 撤销审批通过未生效的离职（approved_voided，B-03 + 撤销）', () => {
  it('直接离职：作废、预减收回、队列失效、时间轴不变；台账只追加', async () => {
    const x = await world('cancel-approved');
    const newcomer = await x.newcomer('调入者');
    const leave = await x.directLeave('2026-10-20');
    expect(await x.exitStates()).toEqual([[leave.id, 'approved']]);

    const result = await x.cancelled(leave.id);

    expect(result).toMatchObject({
      status: 'voided',
      cancellation: { case: 'approved_voided', stateBefore: 'approved' },
    });
    expect(await x.exitStates()).toEqual([]);
    // 预减随作废收回：调出部门编制 1 又被员工占满，另一人 10-10 调入超编（对照 B-21a）
    await x.exceeded(await x.transferInto(newcomer.id, x.from.id, '2026-10-10'));
    // 队列失效：到期调度不再生效，时间轴没有离职记录
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect((await x.effects(leave.id)).map((row) => [row.phase, row.kind])).toEqual([
      ['confirmed', 'establishment_pre_released'],
    ]);
    expect(await x.stateOfBusiness(leave.id)).toBe('voided');
  });

  it('申请离职审批通过后撤销：同样作废，申请流程已办结的实例不动', async () => {
    const x = await world('cancel-approved-application');
    const draft = await x.submittedLeave('2026-10-20');
    await x.approveInReview(draft.id);
    expect(await x.stateOfBusiness(draft.id)).toBe('approved');

    const result = await x.cancelled(draft.id);

    expect(result).toMatchObject({ status: 'voided', cancellation: { case: 'approved_voided' } });
    expect((await x.instanceOf(draft.id))!.status).toBe('approved');
    expect(await x.exitStates()).toEqual([]);
  });

  it('B-17 approval_passed 时机已执行的职责转交：撤销不回退，清单“职责转交”按台账列出', async () => {
    const x = await world('cancel-duty');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.useTiming('approval_passed');
    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-20', 'direct', {
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id, relation: 'direct' }],
          orgRoles: [],
        },
      }),
    );
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);

    // 下属与接收人都在调出部门（编制 1），恢复占编超编，确认后执行
    const result = await x.cancelled(leave.id, { reason: '录入有误', confirmed: true });

    expect(item(result, 'duty_transfer')).toMatchObject({ status: 'found', hiddenCount: 0 });
    expect(item(result, 'duty_transfer').targets).toHaveLength(1);
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
  });

  it('B-60a 撤销清单四类固定顺序：没有对应台账的类目 none，离职交接 / 薪资档案未接入占位', async () => {
    const x = await world('cancel-fixed');
    const leave = await x.directLeave('2026-10-20');

    const result = await x.cancelled(leave.id);

    expect(kinds(result)).toEqual(FIXED);
    expect(result.downstream.items.map((entry) => entry.status)).toEqual([
      'none',
      'none',
      'not_connected',
      'not_connected',
      'none',
    ]);
    // 同一份清单落进撤销记录（撤销后可查）
    expect((await x.cancellationOf(leave.id))!.downstream.items.map((entry) => entry.kind)).toEqual(FIXED);
  });
});

describe('AC-DM-02 撤销已生效的离职（record_deleted_reinstated，B-19）', () => {
  it('恢复在职：时间轴回到前一条开放区间、墓碑、状态回到前一条；清单列出合同与需重新发起的申请', async () => {
    const x = await world('cancel-effective');
    const labor = await x.contractType('劳动合同');
    const contract = await x.createContract(labor);
    const review = await x.transferIn('in_review', '2026-10-20');
    const unconfirmed = await x.reason(await x.createLeave(x.employee.id, leaveBody('2026-10-05', 'direct')));
    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-05', 'direct', { pendingTransferAck: unconfirmed.ackToken }),
    );
    expect(leave.status).toBe('effective');
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    const reviewInstance = (await x.instanceOf(review.id))!;
    expect(reviewInstance.status).toBe('cancelled');

    const result = await x.cancelled(leave.id, { reason: '误办理' });

    expect(result).toMatchObject({
      status: 'deleted',
      cancellation: { case: 'record_deleted_reinstated', stateBefore: 'effective', reason: '误办理' },
    });
    expect((await x.timeline()).map((row) => [row.kind, row.valid])).toEqual([['hire', '[2026-09-01,)']]);
    expect(await x.tombstoned(leave.id)).toBe(true);
    // 版本、状态事件、扩展行、台账全部保留，只追加 deleted
    expect(await x.versions(leave.id)).toHaveLength(1);
    expect((await x.effects(leave.id)).map((row) => row.kind)).toContain('application_voided');
    // 合同不自动恢复；被作废的调动申请保持 voided、实例保持 cancelled（§7.5，不复活）
    expect((await x.contractRows()).find((row) => row.id === contract.id)).toMatchObject({ status: 'terminated' });
    expect(await x.stateOfBusiness(review.id)).toBe('voided');
    expect((await x.instanceOf(review.id))!.status).toBe('cancelled');
    // 清单：合同被终止（需重新签订）；被作废的申请需重新发起
    expect(item(result, 'contract')).toMatchObject({ status: 'found' });
    expect(item(result, 'contract').targets.map((target) => target.id)).toContain(contract.id);
    const voided = result.downstream.additional.find((entry) => entry.kind === 'application_voided')!;
    expect(voided).toMatchObject({ action: 'reinitiate' });
    expect(voided.targets.map((target) => target.id)).toEqual([review.id]);
  });

  it('被撤回的在途合同申请保持 withdrawn，清单提示“需新建”', async () => {
    const x = await world('cancel-effective-contract-request');
    const labor = await x.contractType('劳动合同');
    await x.createContract(labor);
    const nda = await x.contractType('保密协议');
    const request = await x.createContract(nda, { effectiveDate: '2026-12-01', endDate: '2027-11-30' }, 'application');
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    expect((await x.requestRows()).map((row) => row.status)).toContain('withdrawn');

    const result = await x.cancelled(leave.id);

    expect((await x.requestRows()).map((row) => row.status)).toContain('withdrawn');
    const withdrawn = result.downstream.additional.find((entry) => entry.kind === 'contract_request_withdrawn')!;
    expect(withdrawn).toMatchObject({ action: 'reinitiate' });
    expect(withdrawn.targets.map((target) => target.id)).toEqual([request.id]);
  });

  it('B-20 撤销后可再次发起：新业务，不受已撤销的离职影响', async () => {
    const x = await world('cancel-again');
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    await x.cancelled(leave.id);
    const again = await x.createdLeave(x.employee.id, leaveBody('2026-10-04', 'direct'));
    expect(again.id).not.toBe(leave.id);
    expect(again.status).toBe('effective');
  });
});

describe('B-22 撤销入口校验与幂等', () => {
  it('缺原因 / 空白原因 / 多余字段 → 400，无写入', async () => {
    const x = await world('cancel-validate');
    const leave = await x.directLeave('2026-10-20');
    const before = await x.stateOf(x.employee.id);
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 123 }, { reason: 'x', extra: 1 }]) {
      const response = await x.cancel(leave.id, body as never);
      expect(await x.reason(response), JSON.stringify(body)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('revision 不符 → 409 REVISION_CONFLICT；已撤销 / 已作废的离职再撤销 → 409', async () => {
    const x = await world('cancel-revision');
    const leave = await x.directLeave('2026-10-20');
    const stale = (await x.business(leave.id)).revision;
    expect(await x.reason(await x.cancel(leave.id, { reason: '原因' }, { ifMatch: stale + 5 }))).toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
    });
    await x.cancelled(leave.id);
    expect(await x.reason(await x.cancel(leave.id))).toMatchObject({ status: 409 });
  });

  it('同幂等键重放：返回同一回执，不重复写入', async () => {
    const x = await world('cancel-replay');
    const leave = await x.directLeave('2026-10-20');
    const revision = (await x.business(leave.id)).revision;
    const first = await x.cancel(
      leave.id,
      { reason: '原因' },
      { ifMatch: revision, idempotencyKey: 'cancel-replay-1' },
    );
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const after = await x.stateOf(x.employee.id);
    const second = await x.cancel(
      leave.id,
      { reason: '原因' },
      { ifMatch: revision, idempotencyKey: 'cancel-replay-1' },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(await x.stateOf(x.employee.id)).toEqual(after);
    expect((await x.cancellationOf(leave.id))!.revision).toBe(1);
  });

  it('不是离职单（调动）→ 404；撤销只对离职单', async () => {
    const x = await world('cancel-not-exit');
    const transfer = await x.transferIn('draft', '2026-10-20');
    expect(await x.reason(await x.cancel(transfer.id))).toMatchObject({ status: 404 });
  });
});
