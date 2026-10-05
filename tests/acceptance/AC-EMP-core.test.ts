import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';

const testDb = useTestDb();

describe('AC-EMP-01/06/07/09/11 任职记录、周期与时间轴', () => {
  it('AC-EMP-01 一次调动新增任职记录，未改字段继承且旧业务记录保持原值', async () => {
    const session = await employmentSession(testDb().db, 'empcore01');
    const firstOrg = await session.org('调动原部门', { establishedOn: '2026-01-01' });
    const secondOrg = await session.org('调动后部门', { establishedOn: '2026-01-01' });
    const employee = await session.employee('版本链合成员工', 'SYNTHETIC_EMP_01');
    const fields = {
      employType: 'internal',
      departmentId: firstOrg.id,
      place: '合成工作地点A',
      employmentSource: '招聘',
      employmentForm: '全职',
      isKeyPerson: true,
      dimension1: '研发',
      jobNumber: 'SYNTHETIC_EMP_01',
      remarks: '调动仍保留的合成备注',
    };
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields },
      employee.revision,
    );
    expect(hire.status).toBe('effective');
    expect(hire.record).not.toBeNull();
    const before = await session.record(hire.record!.id);
    const transfer = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { departmentId: secondOrg.id } },
      hire.employeeRevision,
    );
    expect(transfer.record!.id).not.toBe(hire.record!.id);
    expect(transfer.record!.staffId).toBe(hire.record!.staffId);
    expect(transfer.record!.previousRecordId).toBe(hire.record!.id);
    expect(transfer.record!.fields).toMatchObject({ ...fields, departmentId: secondOrg.id });
    const rows = await session.records(employee.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((record) => record.id === hire.record!.id)?.fields).toEqual(before.fields);
    expect(rows.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([transfer.record!.id]);
  });

  it('AC-EMP-06 离职后重聘开始新 StaffID 周期，不继承旧周期可选任职字段', async () => {
    const session = await employmentSession(testDb().db, 'empcore06');
    const org = await session.org('重聘部门', { establishedOn: '2026-01-01' });
    const employee = await session.employee('重聘合成员工');
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-08-01',
        fields: { employType: 'internal', departmentId: org.id, place: '旧周期地点', remarks: '旧周期备注' },
      },
      employee.revision,
    );
    const leave = await session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-08-31' },
      hire.employeeRevision,
    );
    const rehire = await session.business(
      employee.id,
      { kind: 'rehire', mode: 'direct', effectiveDate: '2026-09-15', fields: { employType: 'internal' } },
      leave.employeeRevision,
    );
    expect(leave.record!.staffId).toBe(hire.record!.staffId);
    expect(rehire.record!.staffId).not.toBe(hire.record!.staffId);
    expect(rehire.record!.entryDate).toBe('2026-09-15');
    expect(rehire.record!.fields).toMatchObject({ departmentId: null, place: null, remarks: null });
    expect((await session.records(employee.id)).map((record) => record.staffId)).toEqual([
      hire.record!.staffId,
      hire.record!.staffId,
      rehire.record!.staffId,
    ]);
    expect(await session.getEmployee(employee.id)).toMatchObject({ id: employee.id, status: 'employed' });
  });

  it('AC-EMP-07 实习转正保留 StaffID 与继承字段，雇佣关系自动转为内部员工', async () => {
    const session = await employmentSession(testDb().db, 'empcore07');
    const employee = await session.employee('实习合成员工');
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-08-01',
        fields: { employType: 'intern', place: '实习地点', remarks: '实习任职备注' },
      },
      employee.revision,
    );
    const regularized = await session.business(
      employee.id,
      { kind: 'intern_regularization', mode: 'direct', effectiveDate: '2026-09-01' },
      hire.employeeRevision,
    );
    expect(regularized.record!.staffId).toBe(hire.record!.staffId);
    expect(regularized.record!.entryDate).toBe('2026-08-01');
    expect(regularized.record!.fields).toMatchObject({
      employType: 'internal',
      place: '实习地点',
      remarks: '实习任职备注',
    });
    expect(await session.records(employee.id)).toHaveLength(2);
  });

  it('AC-EMP-09 离职生效日期为最后工作日次日，最后工作日仍在职', async () => {
    const session = await employmentSession(testDb().db, 'empcore09');
    const employee = await session.employee('月底离职合成员工');
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { employType: 'internal' } },
      employee.revision,
    );
    const leave = await session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      hire.employeeRevision,
    );
    expect(leave.effectiveDate).toBe('2026-10-01');
    expect(leave.record!.effectiveDate).toBe('2026-10-01');
    expect((await session.records(employee.id, '2026-09-30')).filter((record) => record.isCurrent)[0]?.id).toBe(
      hire.record!.id,
    );
    expect((await session.records(employee.id, '2026-10-01')).filter((record) => record.isCurrent)[0]?.id).toBe(
      leave.record!.id,
    );
    expect(await session.getEmployee(employee.id)).toMatchObject({ status: 'left' });
  });

  it('AC-EMP-11 多条任职含未来直接生效记录时恰有一条当前，最新与当前标志分别计算', async () => {
    const session = await employmentSession(testDb().db, 'empcore11');
    const employee = await session.employee('未来任职合成员工');
    const org = await session.org('合成在职部门', { startDate: '2026-01-01' });
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', departmentId: org.id, place: '入职地点' },
      },
      employee.revision,
    );
    const current = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '当前地点' } },
      hire.employeeRevision,
    );
    const future = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01', fields: { place: '未来地点' } },
      current.employeeRevision,
    );
    expect(future.status).toBe('effective');
    const rows = await session.records(employee.id, '2026-10-01');
    expect(rows).toHaveLength(3);
    expect(rows.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([current.record!.id]);
    expect(rows.filter((record) => record.isLatest).map((record) => record.id)).toEqual([future.record!.id]);
    const afterFutureDate = await session.records(employee.id, '2026-11-01');
    expect(afterFutureDate.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([
      future.record!.id,
    ]);
  });

  it('DEC-041 补录继承插入点前一条，后续匹配字段追加更新且独立值保留', async () => {
    const session = await employmentSession(testDb().db, 'empbackfill');
    const employee = await session.employee('补录合成员工');
    const org = await session.org('合成在职部门', { startDate: '2026-01-01' });
    const hire = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: {
          employType: 'internal',
          departmentId: org.id,
          place: '原始地点',
          employmentType: '原始类别',
          remarks: '原始备注',
        },
      },
      employee.revision,
    );
    const later = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { place: '后来地点', employmentType: '后来类别' },
      },
      hire.employeeRevision,
    );
    const laterBefore = await session.record(later.record!.id);
    const backfill = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { remarks: '补录备注', employmentSource: '补录来源' },
      },
      later.employeeRevision,
    );
    expect(backfill.record!.isInserted).toBe(true);
    expect(backfill.record!.previousRecordId).toBe(hire.record!.id);
    expect(backfill.record!.fields).toMatchObject({
      place: '原始地点',
      employmentType: '原始类别',
      remarks: '补录备注',
    });
    const laterAfter = await session.record(later.record!.id);
    expect(laterAfter.id).toBe(laterBefore.id);
    expect(laterAfter.staffId).toBe(laterBefore.staffId);
    expect(laterAfter.fields).toEqual({ ...laterBefore.fields, employmentSource: '补录来源' });
    expect(laterAfter.customFields).toEqual(laterBefore.customFields);
    expect(laterAfter.previousRecordId).toBe(backfill.record!.id);
    const rows = await session.records(employee.id);
    expect(rows.map((record) => record.effectiveDate)).toEqual(['2026-09-01', '2026-09-10', '2026-09-20']);
    expect(rows.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([later.record!.id]);
  });
});
