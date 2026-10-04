/**
 * R1-T08 定时生效主路径（`08` §12、REQ-TRF-004；原站 W-013 / T2 实测到日由系统定时任务生效）：
 * AC-TRF-04 直接调动保存即生效；AC-TRF-05 审批通过日 ≥ 调动日立即生效；
 * AC-TRF-06 审批通过日 < 调动日：申请单停在「审批通过」、版本链不新增记录（DEC-125），
 * 到调动日由定时任务新增生效记录、前一条止于前一天，审计操作人记为空（系统）。
 */
import { startEmploymentActivationScheduler } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';

const testDb = useTestDb();

describe('AC-TRF-04/05/06 审批通过 ≠ 生效，到期由定时任务落地', () => {
  it('AC-TRF-04：直接调动保存即生效，不经过定时任务', async () => {
    const w = await activationWorld(testDb().db, 'trf04-direct');
    const { employee, hire } = await w.hired();
    const direct = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { departmentId: w.to.id } },
      hire.employeeRevision,
    );
    expect(direct).toMatchObject({ status: 'effective', record: { effectiveDate: '2026-10-01' } });
    const run = await w.runScheduler('2026-10-01T01:00:00Z');
    expect(run.activated).toEqual([]);
  });

  it('AC-TRF-05：审批通过日已到调动日，最后节点通过即生效，定时任务无事可做', async () => {
    const w = await activationWorld(testDb().db, 'trf05-immediate');
    const { employee } = await w.hired();
    const reviewing = await w.apply(employee.id, '2026-10-01', { departmentId: w.to.id });
    const approved = await w.approve(reviewing, '2026-10-01T02:00:00Z');
    expect(approved).toMatchObject({ status: 'effective', record: { effectiveDate: '2026-10-01' } });
    expect((await w.runScheduler('2026-10-01T03:00:00Z')).activated).toEqual([]);
  });

  it('AC-TRF-06：提前审批停在审批通过且只有申请单；到调动日定时任务生效并截断前一条', async () => {
    const w = await activationWorld(testDb().db, 'trf06-scheduled');
    const { employee, hire } = await w.hired();
    const reviewing = await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, place: '新地点' });
    const approved = await w.approve(reviewing, '2026-10-02T02:00:00Z');
    expect(approved).toMatchObject({ status: 'approved', record: null, activation: { status: 'pending' } });
    // DEC-125：审批期间只存申请单，任职版本链不写入任何未来记录，前一条结束日仍为空。
    const chain = await w.session.records(employee.id, '2026-10-05');
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ id: hire.record!.id, stopDate: '9999-12-31', isCurrent: true, isLatest: true });

    // 生效日前一天（北京时间 10-04 23:30）运行：不生效。
    expect((await w.runScheduler('2026-10-04T15:30:00Z')).activated).toEqual([]);
    expect(await w.business(approved.id)).toMatchObject({ status: 'approved', record: null });

    // 生效日当天业务开始前（北京时间 10-05 01:15，原站 W-013 观察到的执行时点）运行：生效。
    const run = await w.runScheduler('2026-10-04T17:15:00Z');
    expect(run).toMatchObject({ businessDate: '2026-10-05', activated: [approved.id], failed: [], suspended: [] });
    const effective = await w.business(approved.id);
    expect(effective).toMatchObject({
      status: 'effective',
      record: {
        effectiveDate: '2026-10-05',
        previousRecordId: hire.record!.id,
        fields: { departmentId: w.to.id, place: '新地点' },
      },
      activation: { status: 'effective', failureCount: 0 },
    });
    expect((await w.session.record(hire.record!.id, '2026-10-05')).stopDate).toBe('2026-10-04');
    const current = (await w.session.records(employee.id, '2026-10-05')).filter((record) => record.isCurrent);
    expect(current).toEqual([expect.objectContaining({ id: approved.id })]);

    // 系统任务的审计操作人为空（不伪造用户），事件时间是运行瞬时（UTC）。
    const audits = await w.auditEvents(approved.id);
    const created = audits.find((event) => event.action === 'employment.record.create');
    expect(created).toMatchObject({ actorUserId: null });
    expect(new Date(created!.occurredAt).toISOString()).toBe('2026-10-04T17:15:00.000Z');
    expect(audits.map((event) => event.action)).toContain('employment.business.state.effective');
    expect((await w.outboxEvents(approved.id)).map((event) => event.eventType)).toContain('employment.record.create');

    // 重复运行（多实例或运维补跑）不重复生效。
    expect((await w.runScheduler('2026-10-04T17:20:00Z')).activated).toEqual([]);
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(2);
  });

  it('DEC-125：未来生效的申请在审批通过期间可删除，删除后定时任务不再落地', async () => {
    const w = await activationWorld(testDb().db, 'trf06-deleted');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const removed = await w.session.request('DELETE', `/businesses/${approved.id}`, { ifMatch: approved.revision });
    expect(removed.status).toBe(200);
    expect((await w.runScheduler('2026-10-04T17:15:00Z')).activated).toEqual([]);
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(1);
  });

  it('进程内调度：启动即运行当前时间槽，同一时间槽重复启动（多实例）不重复生效，stop 等本轮结束', async () => {
    const w = await activationWorld(testDb().db, 'trf06-process');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const errors: unknown[] = [];
    const options = { intervalMs: 3_600_000, clock: () => new Date('2026-10-04T17:15:00Z') };
    const first = startEmploymentActivationScheduler(w.db, { ...options, onError: (error) => errors.push(error) });
    const second = startEmploymentActivationScheduler(w.db, { ...options, onError: (error) => errors.push(error) });
    await Promise.all([first.stop(), second.stop()]);
    expect(errors).toEqual([]);
    expect(await w.business(approved.id)).toMatchObject({ status: 'effective' });
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(2);
    expect(() => startEmploymentActivationScheduler(w.db, { intervalMs: 0 })).toThrow(RangeError);
  });

  it('单次处理量有界：limit 1 只处理一名员工并返回续跑游标，续跑处理剩余员工', async () => {
    const w = await activationWorld(testDb().db, 'trf06-batch');
    const first = await w.hired('分批员工甲');
    const second = await w.hired('分批员工乙');
    const a = await w.approve(await w.apply(first.employee.id, '2026-10-05', { place: '甲' }), '2026-10-02T02:00:00Z');
    const b = await w.approve(await w.apply(second.employee.id, '2026-10-05', { place: '乙' }), '2026-10-02T02:00:00Z');
    const batch = await w.runScheduler('2026-10-04T17:15:00Z', { limit: 1 });
    expect(batch.activated).toHaveLength(1);
    expect(batch.nextCursor).not.toBeNull();
    const rest = await w.runScheduler('2026-10-04T17:16:00Z', { limit: 1, cursor: batch.nextCursor! });
    expect([...batch.activated, ...rest.activated].sort()).toEqual([a.id, b.id].sort());
    const done = await w.runScheduler('2026-10-04T17:17:00Z', { limit: 1, cursor: rest.nextCursor ?? undefined });
    expect(done).toMatchObject({ activated: [], nextCursor: null });
  });
});
