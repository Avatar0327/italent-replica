/**
 * R2-T03 B4 / AC-DM-27（撤销入口）、AC-DM-29（删除）：区间变化统一校验（设计 §6B）。
 * 撤销 approved 离职（表 #1）与撤销已生效离职恢复在职（表 #2）都经同一函数算 ΔO / ΔP（含申请预占）：
 * 组织停用交集直接拒绝（409 EMPLOYMENT_DEPARTMENT_DISABLED），编制超编走 DEC-258 确认（409 CONFIRMATION_REQUIRED，
 * confirmed: true 重提执行并审计）。覆盖 B-63、B-63-rev、B-63a、B-63c、B-63d、B-21、B-21e、B-77 / B-77a、B-85a / B-85b。
 * 每个拒绝用例都断言失败前后离职状态、台账、时间轴、预减投影逐项相等。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cancelWorld, type CancelWorld } from './AC-EXIT-cancel-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => cancelWorld(database().db, label, TODAY);

const disabled = (disabledOn: string) => ({
  status: 409,
  reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
  disabledOn,
});

/** 拒绝：状态码 + reason，且前后整份状态相等（无任何写入）。 */
async function rejected(x: CancelWorld, id: string, expected: object, body: object = { reason: '撤销' }) {
  const before = await x.stateOf(x.employee.id);
  const exits = await x.exitStates();
  const response = await x.cancel(id, body);
  expect(await x.reason(response)).toMatchObject(expected);
  expect(await x.stateOf(x.employee.id)).toEqual(before);
  expect(await x.exitStates()).toEqual(exits);
}

describe('AC-DM-27 B-63 撤销 approved 离职：ΔO 与组织停用相交即拒绝（表 #1）', () => {
  it('B-63 原反例：E 之后已落地的未来直接调动 T 的组织 B 排定 10-26 停用 → 撤销 409；失败前后逐项相等', async () => {
    const x = await world('b63');
    await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    // 按 §6A.1 离职 approved 从 E 起不计占用，T 在 B 的区间随之不计：B 允许排定 10-26 停用
    expect((await x.disable(x.to, '2026-10-26')).status).toBe(200);

    await rejected(x, leave.id, disabled('2026-10-26'));
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
  });

  it('B-63-rev 反向顺序：先撤销离职，再排定 B 的停用 → 停用 409 ORG_SUBTREE_NOT_EMPTY，计数含 T', async () => {
    const x = await world('b63-rev');
    await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    await x.cancelled(leave.id);

    const response = await x.disable(x.to, '2026-10-26');
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ORG_SUBTREE_NOT_EMPTY' } } });
  });

  it('B-63a 组织单人：A 排定 10-22 停用（离职 E = 10-21 之后），撤销 → 409；失败前后相等', async () => {
    const x = await world('b63a');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.disable(x.from, '2026-10-22')).status).toBe(200);
    await rejected(x, leave.id, disabled('2026-10-22'));
  });

  it('B-63c 有限区间不跨停用日：员工 10-10 起已调到 B，A 排定 10-12 停用与撤销无关 → 撤销放行', async () => {
    const x = await world('b63c');
    await x.directTransfer(x.to, '2026-10-10');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.disable(x.from, '2026-10-12')).status).toBe(200);

    const result = await x.cancelled(leave.id);

    expect(result.cancellation.case).toBe('approved_voided');
  });

  it('B-63d E 之后另有同周期的后续记录：10-23 起到 B，B 排定 10-24 停用 → 撤销 409', async () => {
    const x = await world('b63d-reject');
    await x.directTransfer(x.to, '2026-10-23');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.disable(x.to, '2026-10-24')).status).toBe(200);
    await rejected(x, leave.id, disabled('2026-10-24'));
  });

  it('B-63d 对照：B 记录 10-23～10-31 后被另一调动结束，B 排定 11-01 停用与撤销无关 → 放行', async () => {
    const x = await world('b63d-pass');
    await x.directTransfer(x.to, '2026-10-23');
    await x.directTransfer(x.other, '2026-10-31');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.disable(x.to, '2026-11-01')).status).toBe(200);

    expect((await x.cancelled(leave.id)).cancellation.case).toBe('approved_voided');
  });
});

describe('AC-DM-27 撤销已生效离职恢复在职：前一条恢复到最终窗口（表 #2）', () => {
  it('A 在离职生效后排定 10-10 停用（离职截断后无人占用）：恢复在职 → 409，失败前后相等', async () => {
    const x = await world('b63-effective');
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    expect(leave.status).toBe('effective');
    expect((await x.disable(x.from, '2026-10-10')).status).toBe(200);
    await rejected(x, leave.id, disabled('2026-10-10'));
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');
  });
});

describe('AC-DM-27 B-21 / B-21e 编制：ΔP 超编只弹确认（DEC-258），确认后执行并审计', () => {
  /** 超编确认：409 CONFIRMATION_REQUIRED，warnings 列出超编的部门。 */
  const confirmation = (departmentId: string) => ({
    status: 409,
    reason: 'CONFIRMATION_REQUIRED',
    warnings: [expect.objectContaining({ reason: 'ESTABLISHMENT_EXCEEDED', departmentId })],
  });

  it('B-21 撤销恢复在职使 [R, …) 超编：另一人在 R 之后调入同岗位 → 409 确认；confirmed 后执行并记审计', async () => {
    const x = await world('b21');
    const newcomer = await x.newcomer('调入者');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.transferInto(newcomer.id, x.from.id, '2026-10-10')).status).toBe(201);

    await rejected(x, leave.id, confirmation(x.from.id));
    const confirmed = await x.cancel(leave.id, { reason: '撤销', confirmed: true });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(leave.id)).toBe('voided');
    expect(await x.auditActions(leave.id)).toContain('employment.exit.over_capacity_confirmed');
  });

  it('B-21e P 侧：同周期 10-25 起到 B 的未来直接调动，B 严格编制 1 且另一人自 10-26 占用 → ΔP 含 B → 409 确认', async () => {
    const x = await world('b21e');
    const newcomer = await x.newcomer('调入者');
    await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.transferInto(newcomer.id, x.to.id, '2026-10-26')).status).toBe(201);

    await rejected(x, leave.id, confirmation(x.to.id));
    expect((await x.cancel(leave.id, { reason: '撤销', confirmed: true })).status).toBe(200);
  });

  it('未超编时 confirmed 多余也无妨：不写超编确认审计', async () => {
    const x = await world('b21-none');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.cancel(leave.id, { reason: '撤销', confirmed: true })).status).toBe(200);
    expect(await x.auditActions(leave.id)).not.toContain('employment.exit.over_capacity_confirmed');
  });
});

describe('B-77 / B-77a 撤销时审批中调入申请的预占（DEC-496⑤）', () => {
  /** 员工有审批中的调入 B 申请 T（10-25）；离职 L = 10-30（先确认“将作废”）；另一人 Y 自 10-26 调入 B。 */
  async function scene(label: string, lastWorkDate: string) {
    const x = await world(label);
    const newcomer = await x.newcomer('调入者');
    const review = await x.transferInto(x.employee.id, x.to.id, '2026-10-25', 'application');
    expect(review.status, await review.clone().text()).toBe(201);
    const transferId = ((await review.json()) as { id: string }).id;
    const unconfirmed = await x.reason(await x.createLeave(x.employee.id, leaveBody(lastWorkDate, 'direct')));
    expect(unconfirmed).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody(lastWorkDate, 'direct', { pendingTransferAck: unconfirmed.ackToken }),
    );
    return { x, newcomer, transferId, leave };
  }

  it('B-77 离职未落地：撤销时 T 仍审批中，PB 峰值 2 > 1 → 409 确认（warnings 含 PB）；confirmed 后成功并审计', async () => {
    const { x, newcomer, leave, transferId } = await scene('b77', '2026-10-30');
    expect((await x.transferInto(newcomer.id, x.to.id, '2026-10-26')).status).toBe(201);
    expect(leave.status).toBe('approved');

    await rejected(x, leave.id, {
      status: 409,
      reason: 'CONFIRMATION_REQUIRED',
      warnings: [expect.objectContaining({ reason: 'ESTABLISHMENT_EXCEEDED', departmentId: x.to.id })],
    });
    expect((await x.cancel(leave.id, { reason: '撤销', confirmed: true })).status).toBe(200);
    expect(await x.auditActions(leave.id)).toContain('employment.exit.over_capacity_confirmed');
    // 调动 T 没被作废，照常流转
    expect(await x.stateOfBusiness(transferId)).toBe('in_review');
  });

  it('B-77a 对照：离职已生效（T 在落地事务内被作废）→ 撤销时 T 保持 voided，PB 无需确认；清单列出需重新发起', async () => {
    const { x, newcomer, leave, transferId } = await scene('b77a', '2026-10-05');
    expect(leave.status).toBe('effective');
    expect(await x.stateOfBusiness(transferId)).toBe('voided');
    expect((await x.transferInto(newcomer.id, x.to.id, '2026-10-26')).status).toBe(201);

    const result = await x.cancelled(leave.id);

    expect(result.cancellation.case).toBe('record_deleted_reinstated');
    expect(await x.stateOfBusiness(transferId)).toBe('voided');
    const voided = result.downstream.additional.find((entry) => entry.kind === 'application_voided')!;
    expect(voided.targets.map((target) => target.id)).toEqual([transferId]);
  });
});

describe('B-85a / B-85b 撤销入口：共同迟到收敛后', () => {
  /** T 计划 10-20（已批准）、离职 L = 10-29（E = 10-30）；调度停到 11-01，共同迟到：T REBUILD_REQUIRED，离职挂起。 */
  async function converged(label: string) {
    const x = await world(label);
    const transfer = await x.transferIn('approved', '2026-10-20');
    const leave = await x.directLeave('2026-10-29');
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({
      failed: [transfer.id],
      suspended: [leave.id],
    });
    return { x, transfer, leave };
  }

  it('B-85a 撤销离职（approved_voided）后重试 T → T 简单顺延落地，未被作废', async () => {
    const { x, transfer, leave } = await converged('b85a');
    x.setNow('2026-11-02T01:00:00Z');
    const result = await x.cancelled(leave.id);
    expect(result.cancellation.case).toBe('approved_voided');

    const retried = await x.retry(transfer, '2026-11-02T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['transfer', '2026-11-02'],
    ]);
    // 离职离开队列：待办里只剩已处理完的 T，没有离职
    expect((await x.todos()).map((todo) => todo.id)).toEqual([]);
  });

  it('B-85b 删除 T 后重试离职顺延落地；再撤销已生效离职 → 恢复在职，T 不恢复', async () => {
    const { x, transfer, leave } = await converged('b85b');
    x.setNow('2026-11-02T01:00:00Z');
    const removed = await x.session.request('DELETE', `/businesses/${transfer.id}`, {
      ifMatch: (await x.business(transfer.id)).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const retried = await x.retry(leave, '2026-11-02T02:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');

    x.setNow('2026-11-03T01:00:00Z');
    const result = await x.cancelled(leave.id);

    expect(result.cancellation.case).toBe('record_deleted_reinstated');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(await x.stateOfBusiness(transfer.id)).toBe('deleted');
  });
});

describe('AC-DM-29 撤销已生效离职：挂回被摘下的未来调动，下游钩子通知', () => {
  it('B-10 撤销 → T 按台账窗口挂回原位，员工不再读为离职；清单列出“已挂回”', async () => {
    const x = await world('reattach');
    const transfer = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect((await x.timeline()).map((row) => [row.kind, row.valid])).toEqual([
      ['hire', '[2026-09-01,2026-10-21)'],
      ['leave', '[2026-10-21,)'],
    ]);
    x.setNow('2026-10-22T01:00:00Z');

    const result = await x.cancelled(leave.id);

    expect((await x.timeline()).map((row) => [row.kind, row.valid])).toEqual([
      ['hire', '[2026-09-01,2026-10-25)'],
      ['transfer', '[2026-10-25,)'],
    ]);
    expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
    const reattached = result.downstream.additional.find((entry) => entry.kind === 'future_transfer_detached')!;
    expect(reattached).toMatchObject({ action: 'reattached' });
    expect(reattached.targets.map((target) => target.id)).toEqual([transfer.id]);
    // 台账只追加：摘下记录仍在
    expect((await x.effects(leave.id)).map((row) => row.kind)).toContain('future_transfer_detached');
  });
});
