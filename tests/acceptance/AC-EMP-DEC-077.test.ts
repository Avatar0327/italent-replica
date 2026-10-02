import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';

const testDb = useTestDb();

describe('AC-EMP-11 DEC-077 同日跨周期顺序与删除重建', () => {
  it('退休与返聘可在同日发生，返聘成为当前记录并建立新 StaffID', async () => {
    const session = await employmentSession(testDb().db, 'emp-dec077-retire-rehire');
    const employee = await session.employee('同日返聘合成员工');
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-08-01',
        fields: { employType: 'internal' },
      },
      employee.revision,
    );
    const retired = await session.business(
      employee.id,
      {
        kind: 'retirement',
        mode: 'direct',
        lastWorkDate: '2026-09-30',
      },
      hire.employeeRevision,
    );
    const rehired = await session.business(
      employee.id,
      {
        kind: 'retire_rehire',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { employType: 'internal' },
      },
      retired.employeeRevision,
    );
    expect(rehired.record!.staffId).not.toBe(hire.record!.staffId);
    expect(
      (await session.records(employee.id)).filter((record) => record.isCurrent).map((record) => record.id),
    ).toEqual([rehired.id]);
  });

  it('删除同日调动后可按相同生效日重建，同周期同日第二条仍返回409', async () => {
    const session = await employmentSession(testDb().db, 'emp-dec077-delete-recreate');
    const employee = await session.employee('删除重建合成员工');
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal' },
      },
      employee.revision,
    );
    const transfer = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { place: '首次地点' },
      },
      hire.employeeRevision,
    );
    const duplicate = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: transfer.employeeRevision,
      idempotencyKey: randomUUID(),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '冲突地点' } },
    });
    expect(duplicate.status).toBe(409);
    const deleted = await session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: transfer.revision });
    expect(deleted.status).toBe(200);
    const currentEmployee = await session.getEmployee(employee.id);
    const recreated = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { place: '重建地点' },
      },
      currentEmployee.revision,
    );
    expect(recreated.record!.fields).toMatchObject({ place: '重建地点' });
  });
});
