/**
 * R2-T03 B3-3 / AC-DM-26、29：迟到调动与离职交错经公开入口（调度、HR 重试、审批、直接保存）端到端。
 * B3-1 在编排器层验证过的 B-11 / B-85a / B-85b / B-87，这里改走真实入口；另覆盖 B-75（任职状态钩子经公开入口）
 * 与待生效队列看得到离职（pendingActivationState 纳入离职，D-3 / D-4）。
 * B-85a / B-85b 里“撤销离职”属 B4（撤销入口），本批只验证删除 T 的一半。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { pendingActivations, QUEUE_SHIFTED_KINDS } from '../../apps/api/src/modules/employment/activation-store.js';
import {
  registerEmployeeStatusHooks,
  resetEmployeeStatusHooksForTest,
  type EmploymentRecordEvent,
} from '../../apps/api/src/modules/employment/status-hooks.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { queueContext } from './AC-EXIT-queue-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);
type World = Awaited<ReturnType<typeof world>>;

afterEach(() => resetEmployeeStatusHooksForTest());

const queueOf = (x: World, today: string) =>
  withTenant(x.db, x.session.tenant.id, (tx) =>
    pendingActivations(tx, queueContext(x, today), x.employee.id).then((rows) => rows.map((row) => row.id)),
  );

describe('AC-DM-26 公开队列纳入离职，离职与调动同按最终执行日期顺延（D-3 / D-4，§5.0）', () => {
  it('QUEUE_SHIFTED_KINDS 含离职；场景 S：队列 [T, 离职]，调度到期 T REBUILD_REQUIRED、离职 PREDECESSOR_FAILED', async () => {
    expect(QUEUE_SHIFTED_KINDS).toEqual(['transfer', 'leave']);
    const x = await world('open-b11-1');
    const transfer = await x.transferIn('approved', '2026-10-10');
    const leave = await x.directLeave('2026-10-15');
    expect(await queueOf(x, '2026-10-18')).toEqual([transfer.id, leave.id]);

    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({
      failed: [transfer.id],
      suspended: [leave.id],
      activated: [],
    });
    expect((await x.attempts(transfer.id))[0]).toMatchObject({ outcome: 'failed', reason: 'REBUILD_REQUIRED' });
    expect((await x.attempts(leave.id)).at(-1)).toMatchObject({
      outcome: 'suspended',
      reason: 'PREDECESSOR_FAILED',
      blocked_by_business_id: transfer.id,
    });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect([await x.stateOfBusiness(transfer.id), await x.stateOfBusiness(leave.id)]).toEqual(['approved', 'approved']);

    // ② HR 先重试离职 → 409 PREDECESSOR_FAILED，无写入；HR 重试 T 仍 REBUILD_REQUIRED，离职仍挂起
    const before = await x.stateOf(x.employee.id);
    const retryLeave = await x.retry(leave, '2026-10-18T02:00:00Z');
    expect(await x.reason(retryLeave)).toMatchObject({ status: 409, reason: 'PREDECESSOR_FAILED' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect((await x.retry(transfer, '2026-10-18T03:00:00Z')).status).toBe(200);
    expect(await x.stateOfBusiness(transfer.id)).toBe('approved');
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
  });

  it('HR 删除 T 后重试离职：简单顺延成功（L′ = 10-17、E′ = 10-18），计划日仍是 10-16（B-11 恢复路径）', async () => {
    const x = await world('open-b11-retry');
    const transfer = await x.transferIn('approved', '2026-10-10');
    const leave = await x.directLeave('2026-10-15');
    await x.runScheduler('2026-10-18T01:00:00Z');
    x.setNow('2026-10-18T03:00:00Z');
    const current = await x.business(transfer.id);
    expect(
      (await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision })).status,
    ).toBe(200);
    const retried = await x.retry(leave, '2026-10-18T04:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.versions(leave.id)).map((v) => [v.last_work_date, v.planned])).toEqual([
      ['2026-10-15', '2026-10-16'],
      ['2026-10-17', '2026-10-16'],
    ]);
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['leave', '2026-10-18'],
    ]);
  });

  it('B-11b 正例：T 按期先落地、离职随后按期生效，A → T → 离职', async () => {
    const x = await world('open-b11b');
    const transfer = await x.transferIn('approved', '2026-10-10');
    const leave = await x.directLeave('2026-10-15');
    expect(await x.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ activated: [transfer.id] });
    expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'leave']);
  });
});

describe('AC-DM-26 B-85a / B-85b 共同迟到后删除 T 再重试离职（公开入口；撤销入口属 B4）', () => {
  it('队列 [T, 离职]：T REBUILD_REQUIRED、离职挂起；删除 T 后 HR 重试离职顺延落地，时间轴位置按计划日 10-30', async () => {
    const x = await world('open-b85');
    const transfer = await x.transferIn('approved', '2026-10-20');
    const leave = await x.directLeave('2026-10-29');
    expect(await queueOf(x, '2026-11-01')).toEqual([transfer.id, leave.id]);
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({
      failed: [transfer.id],
      suspended: [leave.id],
    });
    x.setNow('2026-11-02T01:00:00Z');
    const current = await x.business(transfer.id);
    expect(
      (await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision })).status,
    ).toBe(200);
    const retried = await x.retry(leave, '2026-11-02T02:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.versions(leave.id)).map((v) => v.planned)).toEqual(['2026-10-30', '2026-10-30']);
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['leave', '2026-11-02'],
    ]);
    expect(await x.todos()).toEqual([]);
  });
});

describe('AC-DM-26 B-87 计划日取首次顺延前的日期（审批 / 调度公开入口）', () => {
  it('①′ 新建 L = 10-19、11-01 才审批通过：审批事务内顺延落地，计划日 10-20 不随顺延版本变化', async () => {
    const x = await world('open-b87-1');
    const draft = await x.submittedLeave('2026-10-19');
    const approved = await x.approve(draft, '2026-11-01T02:00:00Z');
    expect(approved.status).toBe('effective');
    expect((await x.versions(draft.id)).map((v) => [v.last_work_date, v.planned])).toEqual([
      ['2026-10-19', '2026-10-20'],
      ['2026-10-31', '2026-10-20'],
    ]);
    expect((await x.audits(draft.id, 'employment.leave.rescheduled'))[0]!.after).toMatchObject({
      originalEffectiveDate: '2026-10-20',
      effectiveDate: '2026-11-01',
    });
  });

  it('② T 计划 10-25 于 11-01 上午调度迟到落地，离职（计划 10-20）下午审批通过：离职插在 T 之前，T 按 §5.8 摘下', async () => {
    const x = await world('open-b87-2');
    const draft = await x.submittedLeave('2026-10-19');
    const transfer = await x.transferIn('approved', '2026-10-25');
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ activated: [transfer.id] });
    const approved = await x.approve(draft, '2026-11-01T08:00:00Z');
    expect(approved.status).toBe('effective');
    expect((await x.timeline()).map((row) => [row.kind, row.start_date])).toEqual([
      ['hire', '2026-09-01'],
      ['leave', '2026-11-01'],
    ]);
    expect(await x.effects(draft.id)).toContainEqual(
      expect.objectContaining({ phase: 'effective', kind: 'future_transfer_detached', target_id: transfer.id }),
    );
  });
});

describe('AC-DM-29 B-75 任职状态钩子经公开入口', () => {
  it('直接离职保存当场生效：onRecordMaterialized 恰一次（E′、状态 8），全程不调用 onRecordRescheduled', async () => {
    const x = await world('open-b75');
    const events: EmploymentRecordEvent[] = [];
    let rescheduled = 0;
    registerEmployeeStatusHooks('b33-capture', {
      onRecordMaterialized: async (_tx, _ctx, event) => void events.push(event),
      onRecordRescheduled: async () => void (rescheduled += 1),
    });
    const leave = await x.createdLeave(x.employee.id, {
      kind: 'leave',
      mode: 'direct',
      lastWorkDate: '2026-10-05',
      fields: {},
    });
    expect(leave.status).toBe('effective');
    expect(events).toEqual([
      expect.objectContaining({ kind: 'leave', effectiveDate: TODAY, lastWorkDate: '2026-10-05', employeeStatus: 8 }),
    ]);
    // 生效后同一天再跑调度不会重复通知
    await x.runScheduler('2026-10-06T05:00:00Z');
    expect(events).toHaveLength(1);
    expect(rescheduled).toBe(0);
    expect(
      await x.sqlRows(sql`SELECT 1 FROM employment_outbox WHERE tenant_id=${x.session.tenant.id}
        AND business_id=${leave.id}::uuid AND event_type='employment.record.create'`),
    ).toHaveLength(1);
  });
});
