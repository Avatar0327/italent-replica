/**
 * R2-T03 B2a / AC-DM-21 B-36～B-45：逾期迟到调动拦截（设计 §8A，DEC-252①）。
 * 逾期 = 调动的计划生效日（§5.0A）早于租户今天且未落地；三类：A 未落地申请 → 拦截；B 已落地、联动未完成 → 拦截；
 * C 已落地且只剩提醒 → 不拦截。拦截点：创建 / 提交（409 EXIT_LATE_TRANSFER_PENDING，错误体给可见项与 hiddenCount）；
 * approve / 撤销 / 删除 不拦截（由生效编排兜底）。设计 v1.9 的 v1.2 明细表已不在文中，按 §8A 自拟，B-39 属 B3-1，不含。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { findOverdueTransfers } from '../../apps/api/src/modules/employment/activation-store.js';
import { derived, manual, queueContext, seedQueue } from './AC-EXIT-queue-support.js';
import { denyButtons, gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LATER = '2026-10-20';

async function world(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee } = await w.hired();
  return { w, employee };
}

async function expectBlocked(w: Awaited<ReturnType<typeof world>>['w'], employeeId: string, blocker: object) {
  const before = await w.stateOf(employeeId);
  const rejected = await w.reason(await w.createLeave(employeeId, leaveBody(LATER)));
  expect(rejected).toMatchObject({ status: 409, reason: 'EXIT_LATE_TRANSFER_PENDING', hiddenCount: 0 });
  expect(rejected.items).toEqual([blocker]);
  expect(await w.stateOf(employeeId)).toEqual(before);
}

describe('AC-DM-21 逾期迟到调动三类（§8A）', () => {
  it('B-36 A 类：计划日已过、未落地的已批准申请 → 拦截，错误体给出该项', async () => {
    const { w, employee } = await world('overdue-a');
    const id = await w.synthetic(employee.id, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-02' });
    await expectBlocked(w, employee.id, { businessId: id, effectiveDate: '2026-10-02', materialized: false });
  });

  it('B-37 B 类：已落地、联动未完成（非仅提醒）→ 拦截；B-38 C 类：仅提醒 → 不拦截', async () => {
    const { w, employee } = await world('overdue-bc');
    const id = await w.synthetic(employee.id, {
      kind: 'transfer',
      state: 'effective',
      effectiveDate: '2026-10-02',
      linked: true,
    });
    await expectBlocked(w, employee.id, { businessId: id, effectiveDate: '2026-10-02', materialized: true });
    const reminder = await world('overdue-c');
    await reminder.w.synthetic(reminder.employee.id, {
      kind: 'transfer',
      state: 'effective',
      effectiveDate: '2026-10-02',
      linked: true,
      reminderOnly: true,
    });
    expect((await reminder.w.createLeave(reminder.employee.id, leaveBody(LATER))).status).toBe(201);
  });

  it('B-40 计划日 = 今天、B-41 计划日在将来：都不算逾期', async () => {
    for (const [label, date] of [
      ['today', TODAY],
      ['future', '2026-10-09'],
    ] as const) {
      const { w, employee } = await world(`overdue-${label}`);
      await w.synthetic(employee.id, { kind: 'transfer', state: 'approved', effectiveDate: date });
      expect((await w.createLeave(employee.id, leaveBody(LATER))).status, label).toBe(201);
    }
  });

  it('B-42 提交同样拦截（创建后才出现逾期调动）；B-43 删除草稿不拦', async () => {
    const { w, employee } = await world('overdue-submit');
    const draft = await w.createdLeave(employee.id, leaveBody(LATER));
    await w.synthetic(employee.id, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-02' });
    const before = await w.stateOf(employee.id);
    const blocked = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(await w.reason(blocked)).toMatchObject({ status: 409, reason: 'EXIT_LATE_TRANSFER_PENDING' });
    expect(await w.stateOf(employee.id)).toEqual(before);
    const removed = await w.session.request('DELETE', `/businesses/${draft.id}`, { ifMatch: draft.revision });
    expect(removed.status).toBe(200);
  });

  it('B-43 审批通过不拦（已提交的离职，之后才出现逾期调动）', async () => {
    const { w, employee } = await world('overdue-approve');
    const draft = await w.createdLeave(employee.id, leaveBody(LATER));
    const sent = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status).toBe(200);
    await w.synthetic(employee.id, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-02' });
    expect(await w.approve(draft, `${TODAY}T02:00:00Z`)).toMatchObject({ status: 'approved' });
  });

  it('B-44 看不到的逾期调动：仍拦截，只给 hiddenCount 不给 ID', async () => {
    const { w, employee } = await world('overdue-hidden');
    const id = await w.synthetic(employee.id, { kind: 'transfer', state: 'approved', effectiveDate: '2026-10-02' });
    const response = await w.createLeave(employee.id, leaveBody(LATER), w.restricted(denyButtons(), w.session.user.id));
    expect(await response.clone().text()).not.toContain(id);
    expect(await w.reason(response)).toMatchObject({
      status: 409,
      reason: 'EXIT_LATE_TRANSFER_PENDING',
      hiddenCount: 1,
      items: [],
    });
  });

  it('B-45 计划日只经 §5.0A：已被系统顺延到今天的调动仍按首次计划日判逾期', async () => {
    const { w, employee } = await world('overdue-planned');
    await seedQueue(w, employee.id, [
      { kind: 'transfer', versions: [manual(1, '2026-10-01'), derived(2, TODAY)], submitSeq: 1 },
      { kind: 'transfer', versions: [manual(1, TODAY)], submitSeq: 2 },
    ]);
    const { blocking, reminders } = await withTenant(w.db, w.session.tenant.id, (tx) =>
      findOverdueTransfers(tx, queueContext(w, TODAY), employee.id),
    );
    expect(blocking.map((item) => item.effectiveDate)).toEqual(['2026-10-01']);
    expect(reminders).toEqual([]);
  });
});
