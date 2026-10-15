/**
 * B-81 / R2-T03 B1b 第 1 轮 P2：离职的新排序日期（greatest(计划日, 今天)）与实际顺延 / 生效关口一起在 B3-1 启用；
 * 在此之前，现有公开入口对离职保持 main 行为——队列排序、到期、实际落地日、向后更新候选与 main 相同。
 * 夹具只用 main 上已有的入口与导出，在 main 上同样可运行并通过。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { preview } from './AC-FWD-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { queueContext } from './AC-EXIT-queue-support.js';

const database = useTestDb();

/** 最后工作日 10-15（计划生效日 10-16）的离职申请，10-10 提前批准，10-18 之前一直未落地。 */
async function approvedLeave(w: ActivationWorld, employeeId: string) {
  const draft = await w.session.business(
    employeeId,
    { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-15', fields: { place: '原地点' } },
    (await w.session.getEmployee(employeeId)).revision,
  );
  const submitted = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: draft.revision,
    body: {},
  });
  expect(submitted.status).toBe(200);
  const approved = await w.approve(draft, '2026-10-10T01:00:00Z');
  expect(approved.status).toBe('approved');
  return draft;
}

describe('离职在现有公开入口上保持 main 行为（新排序日期待 B3-1 与顺延关口一起启用）', () => {
  it('提前批准的离职（计划生效日 10-16），10-18 队列给出的日期与实际落地日一致，都是 10-16', async () => {
    const w = await activationWorld(database().db, 'exit-entry-queue');
    const person = await w.hired();
    const leave = await approvedLeave(w, person.employee.id);
    const [item] = await withTenant(w.db, w.session.tenant.id, (tx) =>
      pendingActivations(tx, queueContext(w, '2026-10-18'), person.employee.id),
    );
    expect(item).toMatchObject({ id: leave.id, kind: 'leave', effectiveDate: '2026-10-16' });
    expect(await w.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    const landed = (await w.session.records(person.employee.id, '2026-10-18')).filter(
      (record) => record.kind === 'leave',
    );
    expect(landed.map((record) => record.effectiveDate)).toEqual(['2026-10-16']);
  });

  it('补录 10-17 的直接业务：10-16 的离职申请排在它之前，不是向后更新目标（与 main 相同）', async () => {
    const w = await activationWorld(database().db, 'exit-entry-forward', { today: '2026-10-10' });
    const person = await w.hired();
    const leave = await approvedLeave(w, person.employee.id);
    w.session.setNow('2026-10-18T01:00:00.000Z');
    const plan = await preview(w.session, person.employee.id, {
      kind: 'regularization',
      mode: 'direct',
      effectiveDate: '2026-10-17',
      fields: { place: '新地点' },
    });
    expect(plan.changes.map((change) => change.businessId)).not.toContain(leave.id);
  });
});
