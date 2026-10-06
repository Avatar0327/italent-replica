import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
const database = useTestDb();

it('P2-01 迟到直接调动不能越过离职，失败不改日期、人员状态或联动', async () => {
  const w = await activationWorld(database().db, 'f017-r2-leave');
  const person = await w.hired();
  const transfer = await w.session.business(
    person.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { departmentId: w.to.id, isStoreManager: true },
    },
    person.hire.employeeRevision,
  );
  const leave = await w.session.business(
    person.employee.id,
    {
      kind: 'leave',
      mode: 'direct',
      lastWorkDate: '2026-10-05',
    },
    (await w.session.getEmployee(person.employee.id)).revision,
  );
  const result = await w.runScheduler('2026-10-08T01:00:00Z');
  expect(result.failed).toContain(transfer.id);
  expect(result.errors).toEqual([]);
  expect((await w.business(transfer.id)).effectiveDate).toBe('2026-10-05');
  expect((await w.session.records(person.employee.id, '2026-10-08')).find((r) => r.isCurrent)?.id).toBe(leave.id);
  expect(
    (await w.auditEvents(transfer.id)).filter((e) =>
      ['employment.transfer.rescheduled', 'employment.transfer.linked'].includes(e.action),
    ),
  ).toEqual([]);
});

it('P2-02 未来缺失字段不占用当前待补全唯一键', async () => {
  const w = await activationWorld(database().db, 'f017-r2-todo');
  const person = await w.hired();
  const save = async (date: string) => {
    const response = await w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
      ifMatch: (await w.session.getEmployee(person.employee.id)).revision,
      body: {
        initiator: 'hr',
        mode: 'direct',
        transferTypeCode: 'cross_department',
        effectiveDate: date,
        fields: { departmentId: w.to.id, directManagerId: null },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  await save('2026-10-20');
  const current = await save('2026-10-01');
  await w.runScheduler('2026-10-01T02:00:00Z');
  const response = await w.session.request('GET', '/completion-todos');
  expect(await response.json()).toMatchObject({
    items: [
      expect.objectContaining({ id: current.id, fieldCodes: expect.arrayContaining(['preset:directManagerId']) }),
    ],
  });
});

it.each(['direct', 'application'] as const)('DEC-195 %s 迟到同日按原计划日期再操作序号排序', async (mode) => {
  const w = await activationWorld(database().db, `f017-r2-order-${mode}`);
  const person = await w.hired();
  const save = async (date: string, place: string) =>
    mode === 'application'
      ? w.approve(await w.apply(person.employee.id, date, { place }), '2026-10-01T02:00:00Z')
      : w.session.business(
          person.employee.id,
          { kind: 'transfer', mode, effectiveDate: date, fields: { place } },
          (await w.session.getEmployee(person.employee.id)).revision,
        );
  const b = await save('2026-10-06', 'B');
  const a = await save('2026-10-05', 'A');
  expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  const records = await w.session.records(person.employee.id, '2026-10-08');
  expect(records.map((r) => r.id)).toEqual([person.hire.id, a.id, b.id]);
  expect(records.find((r) => r.isCurrent)?.id).toBe(b.id);
});

it('DEC-195 迟到审批按批准日生效并保留计划日期审计', async () => {
  const w = await activationWorld(database().db, 'f017-r2-approval');
  const person = await w.hired();
  const application = await w.apply(person.employee.id, '2026-10-05', { departmentId: w.to.id });
  const approved = await w.approve(application, '2026-10-08T01:00:00Z');
  expect(approved).toMatchObject({ effectiveDate: '2026-10-08', status: 'effective' });
  expect((await w.session.records(person.employee.id, '2026-10-06')).find((r) => r.isCurrent)?.id).toBe(person.hire.id);
  expect(
    (await w.auditEvents(application.id)).find((e) => e.action === 'employment.transfer.rescheduled')?.after,
  ).toMatchObject({ originalEffectiveDate: '2026-10-05', effectiveDate: '2026-10-08' });
});
