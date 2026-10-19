/**
 * B-81 / R2-T03：没有离职扩展行的离职（可信造数端口建的，不经门禁）仍走通用 activate 端口，按 main 行为落地——
 * 到期、实际落地日不顺延；排序日期与向后更新候选随 B3-3 与调动同按最终执行日期（设计 §5.0 / §5.0A D-9）。
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

describe('无扩展行的离职（可信造数）：通用 activate 端口落地，向后更新候选按最终执行日期', () => {
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

  it('补录 10-17 的直接业务：10-16 的离职申请 10-18 才执行（最终执行日期 10-18），排在它之后，成为向后更新候选（D-9）', async () => {
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
    expect(plan.changes.map((change) => change.businessId)).toContain(leave.id);
  });
});
