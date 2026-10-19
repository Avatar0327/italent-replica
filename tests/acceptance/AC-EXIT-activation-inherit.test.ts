/**
 * R2-T03 B3-1 / AC-DM-23：离职落地沿用任职继承矩阵（B-50）并可作为向后更新目标（B-51）。
 * 离职与其他业务同一套 prepareInheritance / resolveEffectiveInheritance：自定义字段 inherit:false 的四种表单形态
 * 与 inherit:true 一致；离职版本永不作为传播来源，但被早于它的补录业务向后更新时只替换等于旧值的字段，状态 8 不变。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { inheritanceFixture } from './AC-EMP-inheritance-support.js';
import { exitActivationWorld, exitActivator } from './AC-EXIT-activation-support.js';

const database = useTestDb();

const cells = [
  { name: 'inherit:true 可编辑', inherit: true, formId: 'standard', expected: '上一任职字段值' },
  { name: 'inherit:true 只读', inherit: true, formId: 'readonly-custom', expected: '上一任职字段值' },
  { name: 'inherit:true 隐藏', inherit: true, formId: 'hidden-custom', expected: '上一任职字段值' },
  { name: 'inherit:true 未拖出', inherit: true, formId: 'omitted-custom', expected: '上一任职字段值' },
  { name: 'inherit:false 可编辑（未填为空）', inherit: false, formId: 'standard', expected: null },
  { name: 'inherit:false 只读（继承）', inherit: false, formId: 'readonly-custom', expected: '上一任职字段值' },
  { name: 'inherit:false 隐藏（继承）', inherit: false, formId: 'hidden-custom', expected: '上一任职字段值' },
  { name: 'inherit:false 未拖出（为空）', inherit: false, formId: 'omitted-custom', expected: null },
] as const;

describe('AC-DM-23 B-50 离职落地的继承矩阵（经内部编排器）', () => {
  it.each(cells)('$name', async ({ inherit, formId, expected }) => {
    const fixture = await inheritanceFixture(database().db, `exit-inherit-${formId}-${inherit}`, inherit);
    fixture.setNow('2026-09-30T01:00:00Z'); // 保存当天 = L：E = 10-01 尚未到，保存为 approved，由编排器入口在 10-01 落地
    const created = await fixture.business(
      fixture.employee.id,
      { kind: 'leave', mode: 'direct', formId, lastWorkDate: '2026-09-30' },
      fixture.hired.employeeRevision,
    );
    expect(created.status).toBe('approved');
    const result = await exitActivator(database().db, fixture)(created.id, '2026-10-01');
    expect(result).toMatchObject({ outcome: 'effective', effectiveDate: '2026-10-01', postponed: false });
    const record = await fixture.record(created.id, '2026-10-01');
    expect(record.customFields[fixture.field.id] ?? null).toBe(expected);
    expect(record.staffId).toBe(fixture.hired.record?.staffId);
    expect(record.fields).toMatchObject({ place: '上一任职工作地', remarks: '上一任职备注', isKeyPerson: true });
  });
});

describe('AC-DM-23 B-51 离职记录作为向后更新目标', () => {
  it('早于离职补录的调动把部门向后更新到离职记录（等于旧值才替换），人员状态 8 不变', async () => {
    const x = await exitActivationWorld(database().db, 'b51', '2026-10-21');
    const leave = await x.directLeave('2026-10-20');
    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    x.setNow('2026-10-21T02:00:00Z');
    const employee = await x.session.getEmployee(x.employee.id);
    await x.session.business(
      x.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-10', fields: { departmentId: x.to.id } },
      employee.revision,
    );
    const records = await x.session.records(x.employee.id, '2026-10-21');
    const left = records.find((record) => record.kind === 'leave')!;
    expect(left.fields.departmentId).toBe(x.to.id);
    const [row] = await x.sqlRows<{ status: number }>(sql`SELECT employee_status AS status FROM employment_records
      WHERE tenant_id=${x.session.tenant.id} AND id=${leave.id}::uuid`);
    expect(row!.status).toBe(8);
    expect((await x.audits(leave.id, 'employment.forward-update')).length).toBeGreaterThan(0);
  });
});
