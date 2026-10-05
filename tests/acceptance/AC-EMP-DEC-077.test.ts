import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, type EmploymentBusiness } from './AC-EMP-support.js';

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
    const records = await session.records(employee.id);
    expect(records.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([rehired.id]);
    // 跨周期同日顺序（DEC-077 保留部分）：结束周期类在前、开新周期类在后
    expect(records.map((record) => record.id)).toEqual([hire.id, retired.id, rehired.id]);
    expect(records.find((record) => record.id === retired.id)).toMatchObject({
      isCurrent: false,
      stopDate: '2026-09-30',
    });
  });

  it('DEC-108 同周期同日第二条不再返回409而按操作先后排在后面；删除后可按相同生效日重建', async () => {
    const session = await employmentSession(testDb().db, 'emp-dec077-delete-recreate');
    const employee = await session.employee('删除重建合成员工');
    const department = await session.org('合成重建部门', { establishedOn: '2026-01-01' });
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', departmentId: department.id },
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
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '同日第二地点' } },
    });
    expect(duplicate.status).toBe(201);
    const second = (await duplicate.json()) as EmploymentBusiness;
    expect(second.record).toMatchObject({
      previousRecordId: transfer.id,
      before: { fields: { place: '首次地点' } },
      isCurrent: true,
    });
    const current = async () =>
      (await session.records(employee.id)).filter((record) => record.isCurrent).map((record) => record.id);
    expect(await current()).toEqual([second.id]);
    const deleted = await session.request('DELETE', `/businesses/${second.id}`, { ifMatch: second.revision });
    expect(deleted.status).toBe(200);
    expect(await current()).toEqual([transfer.id]);
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
    expect((await session.records(employee.id)).map((record) => record.id)).toEqual([
      hire.id,
      transfer.id,
      recreated.id,
    ]);
    expect(await current()).toEqual([recreated.id]);
  });
});
