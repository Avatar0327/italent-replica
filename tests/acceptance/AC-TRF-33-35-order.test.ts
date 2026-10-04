/**
 * AC-TRF-33（DEC-108）：同一员工同一周期同一生效日的多条待生效主职业务，按操作先后（发起先后）依次生效，
 * 当天当前任职取最后一条。AC-TRF-35（DEC-112）：前一条生效失败时，其后的待生效业务（同日在后的、或生效日更晚的）
 * 一律挂起并记“因前序业务失败挂起”；前一条重试成功后按顺序依次生效，版本链不跳号、不乱序。
 */
import { registerEmploymentActivationChecks } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { activationWorld, type ActivationBusiness } from './AC-TRF-activation-support.js';

const testDb = useTestDb();

let fullDepartments = new Set<string>();
registerEmploymentActivationChecks({
  establishmentExceeded: async (_tx, _ctx, target) => fullDepartments.has(target.departmentId ?? ''),
});
afterEach(() => {
  fullDepartments = new Set();
});

describe('AC-TRF-33 DEC-108 同日多条待生效业务按操作先后生效', () => {
  it('先 A 后 B 发起、同为 D 生效：D 当天依次生效，当前任职为 B，B 的变更前取 A', async () => {
    const w = await activationWorld(testDb().db, 'trf33-same-day');
    const { employee } = await w.hired();
    const a = await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, place: 'A 地点' });
    const b = await w.apply(employee.id, '2026-10-05', { place: 'B 地点' });
    // 审批完成先后与发起先后相反：顺序仍按发起先后（操作先后），不按审批完成时间。
    await w.approve(b, '2026-10-02T02:00:00Z');
    await w.approve(a, '2026-10-02T03:00:00Z');

    const run = await w.runScheduler('2026-10-04T17:15:00Z');
    expect(run).toMatchObject({ activated: [a.id, b.id], failed: [], suspended: [] });
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id).slice(-2)).toEqual([a.id, b.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: b.id })]);
    const second = await w.session.record(b.id, '2026-10-05');
    expect(second).toMatchObject({
      previousRecordId: a.id,
      fields: { departmentId: w.to.id, place: 'B 地点' },
    });
  });
});

describe('AC-TRF-35 DEC-112 前序业务生效失败时其后业务挂起', () => {
  it('A（D）编制不足失败；D+5 时 B 不生效、记因前序业务失败挂起；A 重试成功后 B 紧接着生效，顺序 A → B', async () => {
    const w = await activationWorld(testDb().db, 'trf35-suspend');
    const { employee, hire } = await w.hired();
    const a = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const b = await w.approve(await w.apply(employee.id, '2026-10-10', { place: 'B 地点' }), '2026-10-02T03:00:00Z');
    fullDepartments.add(w.to.id);

    expect(await w.runScheduler('2026-10-04T17:15:00Z')).toMatchObject({ failed: [a.id], suspended: [] });
    expect((await w.business(b.id)).activation).toMatchObject({ status: 'pending' });

    const later = await w.runScheduler('2026-10-09T17:15:00Z');
    expect(later).toMatchObject({ activated: [], failed: [], suspended: [b.id] });
    expect(await w.business(b.id)).toMatchObject({
      status: 'approved',
      record: null,
      activation: { status: 'suspended', failureReason: 'PREDECESSOR_FAILED', blockedByBusinessId: a.id },
    });
    expect(await w.session.records(employee.id, '2026-10-10')).toHaveLength(1);
    // 挂起不重复记：再跑一次没有新的挂起。
    expect((await w.runScheduler('2026-10-09T17:30:00Z')).suspended).toEqual([]);
    // 待办只针对失败的那一条；被挂起的业务随前序修正后自动续上。
    expect((await w.todos()).map((todo) => todo.businessId)).toEqual([a.id]);

    fullDepartments.delete(w.to.id);
    const retried = await w.retry(a, '2026-10-11T02:00:00Z');
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as ActivationBusiness).status).toBe('effective');
    const second = await w.business(b.id);
    expect(second).toMatchObject({
      status: 'effective',
      record: {
        effectiveDate: '2026-10-10',
        previousRecordId: a.id,
        fields: { departmentId: w.to.id, place: 'B 地点' },
      },
      activation: { status: 'effective' },
    });
    const chain = await w.session.records(employee.id, '2026-10-11');
    expect(chain.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id]);
    expect(await w.todos()).toEqual([]);
  });

  it('同日在后的业务一并挂起；审批通过日已过生效日的新业务排在失败业务之后也挂起，不插队生效', async () => {
    const w = await activationWorld(testDb().db, 'trf35-same-day');
    const { employee } = await w.hired();
    const a = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const b = await w.approve(await w.apply(employee.id, '2026-10-05', { place: '同日在后' }), '2026-10-02T03:00:00Z');
    fullDepartments.add(w.to.id);
    expect(await w.runScheduler('2026-10-04T17:15:00Z')).toMatchObject({ failed: [a.id], suspended: [b.id] });

    // A 失败后再发起、审批通过时生效日已到的 C：不立即生效，挂起在 A 之后。
    const c = await w.apply(employee.id, '2026-10-06', { place: '审批时已到期' });
    const approved = await w.approve(c, '2026-10-07T02:00:00Z');
    expect(approved).toMatchObject({
      status: 'approved',
      record: null,
      activation: { status: 'suspended', blockedByBusinessId: a.id },
    });
    expect(await w.session.records(employee.id, '2026-10-07')).toHaveLength(1);

    // 被挂起的业务不能越过失败的前序单独重试。
    const jump = await w.retry(c, '2026-10-07T03:00:00Z');
    expect(jump.status).toBe(409);

    fullDepartments.delete(w.to.id);
    expect((await w.retry(a, '2026-10-07T04:00:00Z')).status).toBe(200);
    const chain = await w.session.records(employee.id, '2026-10-07');
    expect(chain.map((record) => record.id).slice(-3)).toEqual([a.id, b.id, c.id]);
    expect(chain.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: c.id })]);
  });

  it('前序业务改为删除：被挂起的业务在下一次运行时按顺序生效', async () => {
    const w = await activationWorld(testDb().db, 'trf35-deleted');
    const { employee } = await w.hired();
    const a = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T02:00:00Z',
    );
    const b = await w.approve(await w.apply(employee.id, '2026-10-10', { place: 'B 地点' }), '2026-10-02T03:00:00Z');
    fullDepartments.add(w.to.id);
    await w.runScheduler('2026-10-04T17:15:00Z');
    expect((await w.runScheduler('2026-10-09T17:15:00Z')).suspended).toEqual([b.id]);
    const failed = await w.business(a.id);
    const removed = await w.session.request('DELETE', `/businesses/${a.id}`, { ifMatch: failed.revision });
    expect(removed.status).toBe(200);
    expect(await w.todos()).toEqual([]);
    expect((await w.runScheduler('2026-10-09T18:00:00Z')).activated).toEqual([b.id]);
    expect(await w.business(b.id)).toMatchObject({
      status: 'effective',
      record: { fields: { departmentId: w.from.id } },
    });
  });
});
