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

/**
 * PR #53 第二轮 P2-2：同日申请与直接业务混合时，生效时插入版本链也按操作先后（DEC-108）与当天已有记录统一排序，
 * 不能一律追加到当日最后。申请的操作时点是提交（原站提交即写入版本链，W-417），直接业务是保存。
 */
describe('AC-TRF-33 DEC-108 同日申请与直接业务混合的先后', () => {
  async function scene(label: string) {
    const w = await activationWorld(testDb().db, label);
    const { employee, hire } = await w.hired();
    const direct = async (fields: Record<string, unknown>) =>
      w.session.business(
        employee.id,
        // DEC-182：使用转正保留混合排序覆盖，已批准调动之后不能直接调动。
        { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-05', fields },
        (await w.session.getEmployee(employee.id)).revision,
      );
    return { w, employee, hire, direct };
  }

  it('先提交并审批申请 A、后保存直接业务 B（同为 D）：D 当天定时落地 A 时插在 B 之前，当前任职为 B', async () => {
    const { w, employee, hire, direct } = await scene('trf33-application-then-direct');
    const a = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, place: 'A 地点' }),
      '2026-10-02T02:00:00Z',
    );
    const b = await direct({ place: 'B 地点' });
    expect(b.record).toMatchObject({ previousRecordId: hire.record!.id, fields: { departmentId: w.from.id } });

    expect((await w.runScheduler('2026-10-04T17:15:00Z')).activated).toEqual([a.id]);
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: b.id })]);
    // A 的变更前取入职记录（插入点之前），B 的变更前改为 A；B 继承的部门随 A 向后更新为调入部门。
    expect(await w.session.record(a.id, '2026-10-05')).toMatchObject({
      previousRecordId: hire.record!.id,
      isInserted: true,
      fields: { departmentId: w.to.id, place: 'A 地点' },
    });
    expect(await w.session.record(b.id, '2026-10-05')).toMatchObject({
      previousRecordId: a.id,
      fields: { departmentId: w.to.id, place: 'B 地点' },
    });
    expect((await w.session.record(hire.record!.id, '2026-10-05')).stopDate).toBe('2026-10-04');
  });

  it('先保存直接业务 B、后提交申请 A（同为 D）：A 落地时排在 B 之后，当前任职为 A', async () => {
    const { w, employee, hire, direct } = await scene('trf33-direct-then-application');
    const b = await direct({ place: 'B 地点' });
    const a = await w.approve(await w.apply(employee.id, '2026-10-05', { place: 'A 地点' }), '2026-10-02T02:00:00Z');
    expect((await w.runScheduler('2026-10-04T17:15:00Z')).activated).toEqual([a.id]);
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.record!.id, b.id, a.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: a.id })]);
    expect(await w.session.record(a.id, '2026-10-05')).toMatchObject({ previousRecordId: b.id, isInserted: false });
  });

  it('先提交申请 A、后保存同日直接业务 B 与 C：A 落地时 B、C 一并后移，顺序 A→B→C，当前任职为 C', async () => {
    const { w, employee, hire, direct } = await scene('trf33-application-then-two-directs');
    const a = await w.approve(await w.apply(employee.id, '2026-10-05', { place: 'A 地点' }), '2026-10-02T02:00:00Z');
    const b = await direct({ place: 'B 地点' });
    const c = await direct({ remarks: 'C 备注' });
    expect((await w.runScheduler('2026-10-04T17:15:00Z')).activated).toEqual([a.id]);
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id, c.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: c.id })]);
    expect(await w.session.record(c.id, '2026-10-05')).toMatchObject({
      previousRecordId: b.id,
      fields: { place: 'B 地点', remarks: 'C 备注' },
    });
  });

  it.each([
    ['离职', 'leave'],
    ['退休', 'retirement'],
  ] as const)(
    '先提交%s申请 A、后保存同日直接转正 B：A 插入会形成“终止任职→同周期转正”，记生效失败，版本链不变',
    async (_label, kind) => {
      const { w, employee, hire, direct } = await scene(`trf33-${kind}-then-direct`);
      const draft = await w.session.business(
        employee.id,
        { kind, mode: 'application', lastWorkDate: '2026-10-04' },
        (await w.session.getEmployee(employee.id)).revision,
      );
      const submitted = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
        ifMatch: draft.revision,
        body: {},
      });
      expect(submitted.status).toBe(200);
      const a = await w.approve(draft, '2026-10-02T02:00:00Z');
      expect(a).toMatchObject({ status: 'approved', effectiveDate: '2026-10-05' });
      const b = await direct({ place: 'B 地点' });

      expect(await w.runScheduler('2026-10-04T17:15:00Z')).toMatchObject({ activated: [], failed: [a.id] });
      expect(await w.business(a.id)).toMatchObject({
        status: 'approved',
        record: null,
        activation: { status: 'failed', failureReason: 'RULE_REJECTED' },
      });
      const records = await w.session.records(employee.id, '2026-10-05');
      expect(records.map((record) => record.id)).toEqual([hire.record!.id, b.id]);
      expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: b.id })]);
    },
  );

  it('暂定口径：同日较早提交、尚未落地的申请 A 不接受之后保存的直接业务 B 的向后更新', async () => {
    const { w, employee, hire, direct } = await scene('trf33-no-forward-to-earlier');
    const a = await w.approve(await w.apply(employee.id, '2026-10-05', { place: 'A 地点' }), '2026-10-02T02:00:00Z');
    expect((await w.business(a.id)).fields).toMatchObject({ departmentId: w.from.id });
    const b = await direct({ departmentId: w.to.id });
    // A 按操作先后排在 B 之前（落地时插在 B 前），B 的变更不向它传播：A 的载荷不变、没有向后更新事件。
    expect((await w.business(a.id)).fields).toMatchObject({ departmentId: w.from.id, place: 'A 地点' });
    expect((await w.auditEvents(a.id)).map((event) => event.action)).not.toContain('employment.forward-update');

    expect((await w.runScheduler('2026-10-04T17:15:00Z')).activated).toEqual([a.id]);
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id]);
    expect(await w.session.record(a.id, '2026-10-05')).toMatchObject({
      fields: { departmentId: w.from.id, place: 'A 地点' },
    });
    expect(await w.session.record(b.id, '2026-10-05')).toMatchObject({
      previousRecordId: a.id,
      fields: { departmentId: w.to.id, place: 'A 地点' },
    });
  });

  it('审批通过时生效日已到（立即生效）也按提交先后插入：先提交 A、后保存 B、再审批 A，当前任职仍为 B', async () => {
    const { w, employee, hire } = await scene('trf33-immediate-approval');
    const submitted = await w.apply(employee.id, '2026-10-05', { place: 'A 地点' });
    // DEC-154 禁止审批中的调动后再直接调动；其他直接业务仍须遵守 DEC-108 的统一插入顺序。
    const b = await w.session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: 'B 地点' } },
      (await w.session.getEmployee(employee.id)).revision,
    );
    const a = await w.approve(submitted, '2026-10-05T02:00:00Z');
    expect(a).toMatchObject({ status: 'effective', record: { previousRecordId: hire.record!.id } });
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.record!.id, a.id, b.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: b.id })]);
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
    expect((await w.todos()).map((todo) => todo.id)).toEqual([a.id]);

    fullDepartments.delete(w.to.id);
    const retried = await w.retry(a, '2026-10-11T02:00:00Z');
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as ActivationBusiness).status).toBe('effective');
    const second = await w.business(b.id);
    expect(second).toMatchObject({
      status: 'effective',
      record: {
        effectiveDate: '2026-10-11',
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
