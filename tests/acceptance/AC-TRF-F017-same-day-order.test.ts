/**
 * 共享契约 C-3（#83 / #100 同一口径）：同一生效日按“最终生效日 → 原计划日（DEC-195①）→ 操作序号（DEC-108）”排序；
 * 离职是终止业务，按该顺序排在它之后的记录按 DEC-252① / DEC-267 拒绝生效、离职不变。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
const departmentBefore = (record: { readonly before?: unknown }) =>
  (record.before as { fields: { departmentId: string | null } } | null)?.fields.departmentId;

async function leave(w: ActivationWorld, employeeId: string, lastWorkDate: string) {
  return w.session.business(
    employeeId,
    { kind: 'leave', mode: 'direct', lastWorkDate, fields: {} },
    (await w.session.getEmployee(employeeId)).revision,
  );
}

function approveAt(w: ActivationWorld, target: { id: string; revision: number }, at: string) {
  return runEmploymentTransition(
    w.db,
    {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: w.session.tenant.timezone,
      now: new Date(at),
      commandId: randomUUID(),
      expectedRevision: target.revision,
    },
    { id: target.id, action: 'approve' },
  );
}

it('两笔迟到审批同日落地：按原计划日排序，当日最终状态取原计划日更晚的那笔', async () => {
  const w = await activationWorld(database().db, 'samedaytwolate');
  const finalOrg = await w.session.org('最终部门', { establishedOn: '2026-01-01' });
  const person = await w.hired();
  const first = await w.apply(person.employee.id, '2026-10-05', { departmentId: w.to.id });
  const second = await w.apply(person.employee.id, '2026-10-08', { departmentId: finalOrg.id });
  await w.approve(second, '2026-10-10T01:00:00Z');
  await w.approve(first, '2026-10-10T02:00:00Z');
  const sameDay = (await w.session.records(person.employee.id, '2026-10-10')).filter(
    (r) => r.effectiveDate === '2026-10-10',
  );
  expect(sameDay.map((r) => r.id)).toEqual([first.id, second.id]);
  expect(sameDay.find((r) => r.isCurrent)).toMatchObject({ id: second.id, fields: { departmentId: finalOrg.id } });
  expect(departmentBefore(await w.session.record(second.id, '2026-10-10'))).toBe(w.to.id);
});

it('正常离职 + 同日稍后批准、原计划日更早的迟到调动：排在离职之前生效，离职仍是当日最后一条', async () => {
  const w = await activationWorld(database().db, 'samedayleavebefore');
  const person = await w.hired();
  const transfer = await w.apply(person.employee.id, '2026-10-05', { departmentId: w.to.id });
  const exit = await leave(w, person.employee.id, '2026-10-09');
  await w.approve(transfer, '2026-10-10T02:00:00Z');
  const sameDay = (await w.session.records(person.employee.id, '2026-10-10')).filter(
    (r) => r.effectiveDate === '2026-10-10',
  );
  expect(sameDay.map((r) => r.id)).toEqual([transfer.id, exit.id]);
  expect(sameDay.find((r) => r.isCurrent)).toMatchObject({ id: exit.id, kind: 'leave' });
  expect(departmentBefore(await w.session.record(exit.id, '2026-10-10'))).toBe(w.to.id);
});

it('离职生效后才批准、最终生效日晚于离职生效日的调动：批准被拒，离职与申请状态不变', async () => {
  const w = await activationWorld(database().db, 'samedayleaveafter');
  const person = await w.hired();
  const transfer = await w.apply(person.employee.id, '2026-10-05', { departmentId: w.to.id });
  const exit = await leave(w, person.employee.id, '2026-10-09');
  const before = await w.session.records(person.employee.id, '2026-10-12');
  await expect(approveAt(w, transfer, '2026-10-12T02:00:00Z')).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await w.business(transfer.id)).status).toBe('in_review');
  expect(await w.session.records(person.employee.id, '2026-10-12')).toEqual(before);
  expect((await w.session.record(exit.id, '2026-10-12')).isCurrent).toBe(true);
});

it('调动先提交、离职后保存，同原计划日：按操作序号调动在前，离职仍是当日最后一条', async () => {
  const w = await activationWorld(database().db, 'samedayopsfirst');
  const person = await w.hired();
  const application = await w.apply(person.employee.id, '2026-10-10', { departmentId: w.to.id });
  const exit = await leave(w, person.employee.id, '2026-10-09');
  expect((await approveAt(w, application, '2026-10-10T02:00:00Z')).status).toBe(200);
  const sameDay = (await w.session.records(person.employee.id, '2026-10-10')).filter(
    (r) => r.effectiveDate === '2026-10-10',
  );
  expect(sameDay.map((r) => r.id)).toEqual([application.id, exit.id]);
  expect(sameDay.find((r) => r.isCurrent)?.id).toBe(exit.id);
});

it('离职先保存：生效日不早于离职生效日的调动申请在保存时即被拒，离职不变', async () => {
  const w = await activationWorld(database().db, 'samedayopsleavefirst');
  const person = await w.hired();
  const exit = await leave(w, person.employee.id, '2026-10-09');
  const before = await w.session.records(person.employee.id, '2026-10-10');
  const employee = await w.session.getEmployee(person.employee.id);
  const response = await w.session.request('POST', `/employees/${person.employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-10', fields: { departmentId: w.to.id } },
  });
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await w.session.records(person.employee.id, '2026-10-10')).toEqual(before);
  expect((await w.session.record(exit.id, '2026-10-10')).isCurrent).toBe(true);
});
