/**
 * R2-T03 B3-1 / AC-DM-14（共存）、26：离职与调动的先后——前序 0a、终止依赖、单一队列、§5.8 摘下已落地未来调动。
 * 覆盖 B-10、B-11 / B-11a / B-11b（编排器层）、B-85a / B-85b（不含撤销入口）、B-87 ①′ / ②（对照例；公开入口版见 AC-EXIT-open-order）。
 * 入口只用内部编排器（activateExit）；调动一侧走公开的调度 / 审批端口（关口只拦离职）。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { loadPlannedEffectiveDate } from '../../apps/api/src/modules/employment/timeline.js';
import { queueContext } from './AC-EXIT-queue-support.js';
import { exitActivationWorld, type ExitActivationWorld } from './AC-EXIT-activation-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => exitActivationWorld(database().db, label, TODAY);

/** 已批准、未到计划日的调动申请（调度与审批端口都不会提前落地）。 */
async function approvedTransfer(x: ExitActivationWorld, effectiveDate: string, approveAt = TODAY) {
  const applied = await x.apply(x.employee.id, effectiveDate, { departmentId: x.to.id });
  return x.approve(applied, `${approveAt}T02:00:00Z`);
}

const queueOf = (x: ExitActivationWorld, today: string) =>
  withTenant(x.db, x.session.tenant.id, (tx) =>
    pendingActivations(tx, queueContext(x, today), x.employee.id).then((rows) => rows.map((row) => row.id)),
  );

describe('AC-DM-26 B-11 迟到调动与离职交错（§10.1，场景 S：T 计划 10-10、离职 E = 10-16、10-18 执行）', () => {
  async function scenario(label: string) {
    const x = await world(label);
    const transfer = await approvedTransfer(x, '2026-10-10');
    const leave = await x.directLeave('2026-10-15');
    return { x, transfer, leave };
  }

  it('① 调度到期：T REBUILD_REQUIRED（blockers 含离职），离职 PREDECESSOR_FAILED 挂起，队列 [T, 离职]', async () => {
    const { x, transfer, leave } = await scenario('b11-1');
    expect(await queueOf(x, '2026-10-18')).toEqual([transfer.id, leave.id]);
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [transfer.id] });
    expect((await x.attempts(transfer.id))[0]).toMatchObject({ outcome: 'failed', reason: 'REBUILD_REQUIRED' });
    expect(((await x.attempts(transfer.id))[0]!.detail as { blockers: { id: string }[] }).blockers[0]!.id).toBe(
      leave.id,
    );
    const before = await x.stateOf(x.employee.id);
    // B-11a：T 与离职没有联动足迹交集，仍因终止依赖不豁免——离职不得先落地（否则会作废 T）
    expect(await x.activate(leave.id, '2026-10-18')).toMatchObject({
      outcome: 'suspended',
      reason: 'PREDECESSOR_FAILED',
      blockedByBusinessId: transfer.id,
    });
    expect((await x.attempts(leave.id)).at(-1)).toMatchObject({
      outcome: 'suspended',
      reason: 'PREDECESSOR_FAILED',
      blocked_by_business_id: transfer.id,
    });
    const after = await x.stateOf(x.employee.id);
    expect(after.timeline).toEqual(before.timeline);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });

  it('② HR 先重试离职：前序 T 尚未执行 → 409 ACTIVATION_PREDECESSOR_PENDING，无写入；T 失败后 HR 重试 T 仍失败、离职仍挂起', async () => {
    const { x, transfer, leave } = await scenario('b11-2');
    const before = await x.stateOf(x.employee.id);
    await expect(x.activate(leave.id, '2026-10-18', { trigger: 'retry' })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ACTIVATION_PREDECESSOR_PENDING' },
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    await x.runScheduler('2026-10-18T01:00:00Z');
    const retried = await x.retry(transfer, '2026-10-18T02:00:00Z');
    expect(retried.status).toBe(200);
    expect(await x.activate(leave.id, '2026-10-18', { trigger: 'retry' })).toMatchObject({ outcome: 'suspended' });
  });

  it('③ 离职 10-18 才批准：T 尚未执行 → 审批落地不落地、不记尝试；T 10-18 才批准：T 失败，离职挂起', async () => {
    const x = await world('b11-3a');
    const transfer = await approvedTransfer(x, '2026-10-10');
    const leave = await x.approvedLeave('2026-10-15', '2026-10-18');
    expect(await x.activate(leave.id, '2026-10-18', { trigger: 'approval' })).toMatchObject({ outcome: 'pending' });
    expect(await x.attempts(leave.id)).toEqual([]);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(await x.stateOfBusiness(transfer.id)).toBe('approved');

    const y = await world('b11-3b');
    const leaveB = await y.directLeave('2026-10-15');
    const applied = await y.apply(y.employee.id, '2026-10-10', { departmentId: y.to.id });
    await y.approve(applied, '2026-10-18T02:00:00Z');
    expect((await y.attempts(applied.id))[0]).toMatchObject({ outcome: 'failed', reason: 'REBUILD_REQUIRED' });
    expect(await y.activate(leaveB.id, '2026-10-18', { trigger: 'approval' })).toMatchObject({
      outcome: 'suspended',
      blockedByBusinessId: applied.id,
    });
  });

  it('HR 删除 T 后重试离职：简单顺延成功（L′ = 10-17、E′ = 10-18），计划日仍是 10-16', async () => {
    const { x, transfer, leave } = await scenario('b11-retry');
    await x.runScheduler('2026-10-18T01:00:00Z');
    x.setNow('2026-10-18T03:00:00Z');
    const current = await x.business(transfer.id);
    expect(
      (await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision })).status,
    ).toBe(200);
    expect(await x.activate(leave.id, '2026-10-18', { trigger: 'retry' })).toMatchObject({
      outcome: 'effective',
      lastWorkDate: '2026-10-17',
      effectiveDate: '2026-10-18',
    });
    const planned = await withTenant(x.db, x.session.tenant.id, (tx) =>
      loadPlannedEffectiveDate(tx, x.session.tenant.id, leave.id, '1900-01-01'),
    );
    expect(planned).toBe('2026-10-16');
  });

  it('B-11b 正例：T 按期先落地，离职随后落地，A → T → 离职，前驱为 T', async () => {
    const { x, transfer, leave } = await scenario('b11b');
    expect(await x.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ activated: [transfer.id] });
    expect(await x.activate(leave.id, '2026-10-16')).toMatchObject({ outcome: 'effective', postponed: false });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
  });
});

describe('AC-DM-26 B-85a / B-85b 共同迟到后删除 T 再重试离职（不含撤销入口）', () => {
  it('队列 [T, 离职]：T REBUILD_REQUIRED、离职挂起；删除 T 后离职顺延落地，时间轴位置按计划日 10-30', async () => {
    const x = await world('b85');
    const transfer = await approvedTransfer(x, '2026-10-20');
    const leave = await x.directLeave('2026-10-29');
    expect(await queueOf(x, '2026-11-01')).toEqual([transfer.id, leave.id]);
    await x.runScheduler('2026-11-01T01:00:00Z');
    expect(await x.activate(leave.id, '2026-11-01')).toMatchObject({ outcome: 'suspended' });
    x.setNow('2026-11-02T01:00:00Z');
    const current = await x.business(transfer.id);
    expect(
      (await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision })).status,
    ).toBe(200);
    expect(await x.activate(leave.id, '2026-11-02', { trigger: 'retry' })).toMatchObject({
      outcome: 'effective',
      lastWorkDate: '2026-11-01',
      effectiveDate: '2026-11-02',
    });
    expect((await x.versions(leave.id)).map((v) => v.planned)).toEqual(['2026-10-30', '2026-10-30']);
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['leave', '2026-11-02'],
    ]);
  });
});

describe('AC-DM-26 B-87 计划日取首次顺延前的日期，同日已落地迟到调动的先后', () => {
  it('①′ 新建 L = 10-19、11-01 才执行：顺延落地，计划日 10-20，不受后续版本影响', async () => {
    const x = await world('b87-1');
    const leave = await x.approvedLeave('2026-10-19', '2026-11-01');
    expect(await x.activate(leave.id, '2026-11-01', { trigger: 'approval' })).toMatchObject({
      outcome: 'effective',
      lastWorkDate: '2026-10-31',
      effectiveDate: '2026-11-01',
    });
    expect((await x.versions(leave.id)).map((v) => v.planned)).toEqual(['2026-10-20', '2026-10-20']);
  });

  it('② 对照：T 计划 10-15 先于离职计划日 → 离职插在 T 之后、前驱 = T，不摘下', async () => {
    const x = await world('b87-3');
    const transfer = await approvedTransfer(x, '2026-10-15');
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ activated: [transfer.id] });
    x.setNow('2026-11-01T01:00:00Z');
    const leave = await x.directLeave('2026-10-19');
    expect(await x.activate(leave.id, '2026-11-01')).toMatchObject({ outcome: 'effective', postponed: true });
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['transfer', '2026-11-01'],
      ['leave', '2026-11-01'],
    ]);
    expect((await x.effects(leave.id)).map((row) => row.kind)).not.toContain('future_transfer_detached');
  });
});

describe('AC-DM-14 B-10 / DEC-263② 已落地未来直接调动 T：离职照常生效，T 的时间轴行摘下', () => {
  it('摘下 T（记录保留）、员工自 E′ 起离职；台账与审计；T 到期复查 failed，HR 可删除 T', async () => {
    const x = await world('b10');
    const employee = await x.session.getEmployee(x.employee.id);
    const transfer = await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-25', fields: { departmentId: x.to.id } },
      employee.revision,
    );
    const leave = await x.directLeave('2026-10-20');
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect((await x.timeline()).map((row) => [row.kind, row.valid])).toEqual([
      ['hire', '[2026-09-01,2026-10-21)'],
      ['leave', '[2026-10-21,)'],
    ]);
    expect(await x.sqlRows(sql`SELECT 1 FROM employment_records WHERE id=${transfer.id}::uuid`)).toHaveLength(1);
    const detached = (await x.effects(leave.id)).find((row) => row.kind === 'future_transfer_detached');
    expect(detached).toMatchObject({ phase: 'effective', target_id: transfer.id });
    expect(detached!.detail).toMatchObject({ window: { from: '2026-10-25', to: null } });
    expect((await x.audits(leave.id, 'employment.exit.future_transfer_warning')).length).toBe(1);
    // 到期复查：不执行联动，记失败交 HR（DEC-052）
    expect(await x.runScheduler('2026-10-25T01:00:00Z')).toMatchObject({ failed: [transfer.id] });
    expect((await x.attempts(transfer.id)).at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'EMPLOYEE_DEPARTED_BEFORE_TRANSFER',
    });
    x.setNow('2026-10-26T01:00:00Z');
    const current = await x.business(transfer.id);
    expect(
      (await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision })).status,
    ).toBe(200);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'leave']);
  });
});
