/**
 * R2-T04 BE-5a′ / AC-RT-11：撤销退休四种情况（c2，设计 §6）。
 * 与离职同一个 cancelExit：process_voided / approved_voided / record_deleted_reinstated 与离职同结果，§6B 区间变化统一校验
 * （停用交集 409 EMPLOYMENT_DEPARTMENT_DISABLED，超编 409 CONFIRMATION_REQUIRED 确认后执行），人员状态回到退休前；
 * 审计沿用 exit.request.cancel（kind = retirement）。record_deleted（今天 ≤ L′）在退休上不会出现（E′ ≤ 今天才落地，L′ < 今天），
 * 判定函数同一个，见 exitCancelCase 的纯函数断言。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitCancelCase } from '../../apps/api/src/modules/employment/exit-cancel.js';
import { retireBody } from './AC-RT-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementCancelWorld(database().db, label, TODAY);

describe('AC-RT-11 未办结的退休（process_voided）', () => {
  it('草稿：删除；审批中 / 已驳回：作废并取消审批实例；审计 kind = retirement', async () => {
    const x = await world('rt11-process');
    const draft = await x.createdRetire(x.employee.id, retireBody('2026-10-20', 'application'));
    const deleted = await x.retireCancelled(draft.id, { reason: '  录入有误  ' });
    expect(deleted).toMatchObject({
      status: 'deleted',
      cancellation: { case: 'process_voided', stateBefore: 'draft', reason: '录入有误', revision: 1 },
    });
    const [audit] = await x.audits(draft.id, 'exit.request.cancel');
    expect(audit!.after).toMatchObject({ case: 'process_voided', kind: 'retirement' });

    const review = await x.submittedRetire('2026-10-20');
    const instance = (await x.instanceOf(review.id))!;
    expect(await x.retireCancelled(review.id)).toMatchObject({ status: 'voided' });
    expect((await x.instanceOf(review.id))!.status).toBe('cancelled');
    expect(await x.pendingTasks(instance.id)).toEqual([]);

    const rejected = await x.submittedRetire('2026-10-22');
    await x.rejectInReview(rejected.id);
    expect(await x.retireCancelled(rejected.id)).toMatchObject({
      status: 'voided',
      cancellation: { case: 'process_voided', stateBefore: 'rejected' },
    });
  });
});

describe('AC-RT-11 撤销审批通过未生效的退休（approved_voided）', () => {
  it('预减收回、到期调度不再生效、时间轴不变、台账只追加', async () => {
    const x = await world('rt11-approved');
    const newcomer = await x.newcomer('调入者');
    const retire = await x.directRetire('2026-10-20');
    expect(await x.exitStates()).toEqual([[retire.id, 'approved']]);

    const result = await x.retireCancelled(retire.id);

    expect(result).toMatchObject({
      status: 'voided',
      cancellation: { case: 'approved_voided', stateBefore: 'approved' },
    });
    expect(await x.exitStates()).toEqual([]);
    await x.exceeded(await x.transferInto(newcomer.id, x.from.id, '2026-10-10'));
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect((await x.effects(retire.id)).map((row) => [row.phase, row.kind])).toEqual([
      ['confirmed', 'establishment_pre_released'],
    ]);
    expect(await x.cancellationOf(retire.id)).toMatchObject({ case: 'approved_voided', stateBefore: 'approved' });
    const [audit] = await x.audits(retire.id, 'exit.request.cancel');
    expect(audit!.after).toMatchObject({ case: 'approved_voided', kind: 'retirement' });
  });

  it('申请退休审批通过后撤销：同样作废，办结的审批实例不动', async () => {
    const x = await world('rt11-approved-application');
    const draft = await x.submittedRetire('2026-10-20');
    await x.approveInReview(draft.id);
    expect(await x.stateOfBusiness(draft.id)).toBe('approved');

    expect(await x.retireCancelled(draft.id)).toMatchObject({
      status: 'voided',
      cancellation: { case: 'approved_voided' },
    });
    expect((await x.instanceOf(draft.id))!.status).toBe('approved');
  });
});

describe('AC-RT-11 撤销已生效的退休（record_deleted_reinstated）：人员状态回到退休前', () => {
  it('时间轴回到前一条开放区间、墓碑、状态回在职；版本 / 台账保留', async () => {
    const x = await world('rt11-effective');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect(retire.status).toBe('effective');
    expect(await x.employeeStatusOf(retire.id)).toBe(6);
    const [hire] = await x.timeline();
    const statusBefore = await x.employeeStatusOf(hire!.record_id);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);

    const result = await x.retireCancelled(retire.id, { reason: '误办理' });

    expect(result).toMatchObject({
      status: 'deleted',
      cancellation: { case: 'record_deleted_reinstated', stateBefore: 'effective', reason: '误办理' },
    });
    expect((await x.timeline()).map((row) => [row.kind, row.valid])).toEqual([['hire', '[2026-09-01,)']]);
    expect(await x.tombstoned(retire.id)).toBe(true);
    expect(await x.versions(retire.id)).toHaveLength(1);
    // 时间轴末条回到入职记录，人员状态是退休前的值（不是 6 退休）
    expect(await x.employeeStatusOf(hire!.record_id)).toBe(statusBefore);
    expect(statusBefore).not.toBe(6);
    const [audit] = await x.audits(retire.id, 'exit.request.cancel');
    expect(audit!.after).toMatchObject({ case: 'record_deleted_reinstated', kind: 'retirement' });
  });

  it('撤销后可再次发起退休：新业务，不受已撤销的影响', async () => {
    const x = await world('rt11-again');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    await x.retireCancelled(retire.id);
    const again = await x.createdRetire(x.employee.id, retireBody('2026-10-04', 'direct'));
    expect(again.id).not.toBe(retire.id);
    expect(again.status).toBe('effective');
  });
});

describe('AC-RT-11 §6B 区间变化统一校验（与离职同一函数）', () => {
  it('撤销 approved 退休：A 排定 10-22 停用（E = 10-21 之后）→ 409 EMPLOYMENT_DEPARTMENT_DISABLED，无写入', async () => {
    const x = await world('rt11-disabled');
    const retire = await x.directRetire('2026-10-20');
    expect((await x.disable(x.from, '2026-10-22')).status).toBe(200);
    const before = await x.stateOf(x.employee.id);

    const response = await x.cancelRetire(retire.id);

    expect(await x.reason(response)).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
      disabledOn: '2026-10-22',
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.stateOfBusiness(retire.id)).toBe('approved');
    expect(await x.cancellationOf(retire.id)).toBeUndefined();
  });

  it('撤销已生效退休恢复在职：A 在退休后排定 10-10 停用 → 409，仍 effective', async () => {
    const x = await world('rt11-disabled-effective');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect((await x.disable(x.from, '2026-10-10')).status).toBe(200);

    expect(await x.reason(await x.cancelRetire(retire.id))).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    expect(await x.stateOfBusiness(retire.id)).toBe('effective');
    expect((await x.retirementDates()).actual).toBe(TODAY);
  });

  it('撤销使 [R, …) 超编：另一人在 R 之后调入同岗位 → 409 确认；confirmed 后执行', async () => {
    const x = await world('rt11-exceeded');
    const newcomer = await x.newcomer('调入者');
    const retire = await x.directRetire('2026-10-20');
    expect((await x.transferInto(newcomer.id, x.from.id, '2026-10-10')).status).toBe(201);

    expect(await x.reason(await x.cancelRetire(retire.id))).toMatchObject({
      status: 409,
      reason: 'CONFIRMATION_REQUIRED',
      warnings: [expect.objectContaining({ reason: 'ESTABLISHMENT_EXCEEDED', departmentId: x.from.id })],
    });
    expect(await x.stateOfBusiness(retire.id)).toBe('approved');

    const confirmed = await x.cancelRetire(retire.id, { reason: '撤销', confirmed: true });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(retire.id)).toBe('voided');
  });
});

describe('AC-RT-11 撤销情况判定与离职同一函数', () => {
  it('exitCancelCase：状态 + 今天与 L′ 的关系决定四种情况；不可撤销的状态 409', () => {
    expect(exitCancelCase('draft', TODAY, null)).toBe('process_voided');
    expect(exitCancelCase('approved', TODAY, '2026-10-20')).toBe('approved_voided');
    expect(exitCancelCase('effective', TODAY, '2026-10-06')).toBe('record_deleted');
    expect(exitCancelCase('effective', TODAY, '2026-10-05')).toBe('record_deleted_reinstated');
    expect(() => exitCancelCase('voided', TODAY, null)).toThrow();
  });
});
