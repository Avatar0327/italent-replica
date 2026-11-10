/**
 * AC-F476-13（P5 部分：合同四种操作、兼职新增 / 延长 / 结束）：办理时冻结请求内容，事后申请被改 / 目标变更，
 * 已办人经各自的申请详情接口读到办理时的值；待办人与发起人读现值。审批通过不等于生效；主数据接口保持当前值。
 * 「留给 P4 / P7」：任职操作、退休意向与考核的同类断言。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import {
  CONTRACTS,
  PERSONNEL,
  act,
  contractScene,
  get,
  handledThenResubmitted,
  latestInstance,
  personnelScene,
  textFieldOf,
} from './AC-F476-p5-support.js';

const testDb = useTestDb();

describe('AC-F476-13 合同四种操作：已办读办理时的请求内容', () => {
  const cases = [
    { operation: 'create', fields: { endDate: '2027-09-30' }, changed: { endDate: '2028-09-30' }, key: 'endDate' },
    {
      operation: 'renew',
      fields: { effectiveDate: '2026-10-01', endDate: '2027-09-30' },
      changed: { endDate: '2028-09-30' },
      key: 'endDate',
    },
    {
      operation: 'change',
      fields: { effectiveDate: '2025-03-01' },
      changed: { effectiveDate: '2025-04-01' },
      key: 'effectiveDate',
    },
    {
      operation: 'terminate',
      fields: { actualTerminationDate: '2026-09-30' },
      changed: { actualTerminationDate: '2026-09-29' },
      key: 'actualTerminationDate',
    },
  ] as const;

  it.each(cases)('$operation：n2 驳回后发起人改 $key，n2 读办理时值，n1 待办与发起人读现值', async (c) => {
    const s = await contractScene(testDb().db, `f476-13p5-${c.operation}`);
    const { w, n1, n2 } = s;
    const target = c.operation === 'create' ? undefined : await s.direct();
    const request = await s.apply(c.operation, { ...c.fields }, target);
    await handledThenResubmitted(s, 'contract', request.id, { ...c.changed });
    const before = (c.fields as Record<string, unknown>)[c.key];
    const after = (c.changed as Record<string, unknown>)[c.key];

    const handled = await get(w, n2.userId, s.requestPath(request.id));
    expect(handled.status).toBe(200);
    expect([handled.body[c.key], (handled.body.submittedFields as Record<string, unknown>)[c.key]]).toEqual([
      before,
      before,
    ]);
    expect(handled.body.contentView?.mode).toBe('frozen');

    for (const viewer of [n1.userId, w.hr.id]) {
      const live = await get(w, viewer, s.requestPath(request.id));
      expect([live.body[c.key], live.body.contentView?.mode]).toEqual([after, 'live']);
    }
    expect((await latestInstance(w, 'contract', request.id)).status).toBe('running');
  });
});

describe('AC-F476-13 兼职新增 / 延长 / 结束：已办读办理时的结束日期', () => {
  const PT = '/api/tenant/employment/part-time-requests';
  const cases = [
    { kind: 'add', after: '2026-12-31' },
    { kind: 'extend', after: '2027-01-31' },
    { kind: 'end', after: '2026-10-20' },
  ] as const;

  it.each(cases)('$kind：第 2 个节点审批人改结束日后，第 1 个节点审批人读办理时值', async (c) => {
    const w = await requestWorld(testDb().db, `f476-13p5-pt-${c.kind}`, { editMode: 'with_approve' });
    const record = c.kind === 'add' ? null : await w.seedRecord({ endDate: '2026-10-31' });
    const created =
      c.kind === 'add'
        ? await w.create({ endDate: null })
        : await w[c.kind](record!, c.kind === 'end' ? '2026-10-15' : '2026-12-31');
    await w.send(created.id, created.revision);
    const [first, second, third] = w.order[c.kind];
    const originalEnd = c.kind === 'add' ? null : c.kind === 'end' ? '2026-10-15' : '2026-12-31';
    await w.decide(created.id, first!, 'approve');
    await w.decide(created.id, second!, 'approve', { endDate: c.after });

    const handled = await get(w, first!.userId, `${PT}/${created.id}`);
    expect(handled.status, JSON.stringify(handled.body)).toBe(200);
    expect([handled.body.endDate, handled.body.contentView?.mode]).toEqual([originalEnd, 'frozen']);
    for (const viewer of [third!.userId, w.hr.id]) {
      const live = await get(w, viewer, `${PT}/${created.id}`);
      expect([live.body.endDate, live.body.contentView?.mode]).toEqual([c.after, 'live']);
    }
  });
});

describe('AC-F476-13 批准不等于生效；主数据接口保持现值', () => {
  it('合同：变更申请被修改后，合同记录接口仍是当前合同（不带办理视图），已办人读申请详情才是冻结值', async () => {
    const s = await contractScene(testDb().db, 'f476-13p5-master');
    const { w, n1, n2 } = s;
    const target = await s.direct();
    const request = await s.apply('change', { effectiveDate: '2025-03-01' }, target);
    await handledThenResubmitted(s, 'contract', request.id, { effectiveDate: '2025-04-01' });

    const master = await get(w, w.hr.id, `${CONTRACTS}/records/${target.id}`);
    expect(master.status, JSON.stringify(master.body)).toBe(200);
    expect(master.body.effectiveDate).toBe('2025-01-01');
    expect(master.body.contentView).toBeUndefined();
    const handled = await get(w, n2.userId, s.requestPath(request.id));
    expect([handled.body.effectiveDate, handled.body.contentView?.mode]).toEqual(['2025-03-01', 'frozen']);
    expect((await get(w, n1.userId, s.requestPath(request.id))).body.effectiveDate).toBe('2025-04-01');
  });
});

describe('AC-F476-13 员工子集：显式清空与删除目标记录', () => {
  const subset = 'education';
  const field = textFieldOf(subset);

  it('显式清空：办理时的 null 与原值都保留在冻结内容里', async () => {
    const s = await personnelScene(testDb().db, 'f476-13p5-clear');
    const { w, n1, n2 } = s;
    const target = await s.record(subset, { [field]: 'ZZ_原值' });
    const request = await s.apply(subset, { [field]: null }, target);
    const instance = await latestInstance(w, 'personnel_change', request.id);
    await act(w, instance.id, n1, 'approve');
    await act(w, instance.id, n2, 'reject');
    await w.instanceAction(s.subject.userId, instance.id, 'resubmit', (await w.detail(instance.id)).revision, {
      body: { fields: { [field]: 'ZZ_改后' } },
    });

    const handled = await get(w, n2.userId, s.requestPath(request.id));
    expect(handled.status, JSON.stringify(handled.body)).toBe(200);
    expect(handled.body.currentValues).toEqual({ [field]: null });
    expect(handled.body.originals).toEqual({ [field]: 'ZZ_原值' });
    expect(handled.body.contentView?.mode).toBe('frozen');
  });

  it('目标记录事后被删除：已办人仍读办理时的原值（取自 targetRevision 对应版本）', async () => {
    const s = await personnelScene(testDb().db, 'f476-13p5-deleted');
    const { w, n1 } = s;
    const target = await s.record(subset, { [field]: 'ZZ_原值' });
    const request = await s.apply(subset, { [field]: 'ZZ_办理时' }, target);
    const instance = await latestInstance(w, 'personnel_change', request.id);
    await act(w, instance.id, n1, 'approve');
    const removed = await w.request(
      w.hr.id,
      'DELETE',
      `${PERSONNEL}/employees/${s.subject.employeeId}/subsets/${subset}/${target.id}`,
      { ifMatch: target.revision },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);

    const handled = await get(w, n1.userId, s.requestPath(request.id));
    expect(handled.status, JSON.stringify(handled.body)).toBe(200);
    expect(handled.body.originals).toEqual({ [field]: 'ZZ_原值' });
    expect(handled.body.contentView?.mode).toBe('frozen');
  });
});
