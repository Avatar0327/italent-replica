import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { employmentSession, type EmploymentBusiness } from './AC-EMP-support.js';
import { customField, inheritanceFixture, trustedTransition } from './AC-EMP-inheritance-support.js';

const testDb = useTestDb();

describe('AC-EMP-08 入职忽略继承设置与跨任职周期', () => {
  it.each([true, false])('新增入职，继承设置%s不产生任何默认值', async (inherit) => {
    const session = await employmentSession(testDb().db, `inherit-hire-${inherit}`);
    const field = await customField(session, inherit);
    const employee = await session.employee();
    const input = { kind: 'hire', mode: 'direct', formId: 'standard', effectiveDate: '2026-01-01' };
    const preview = await session.request('POST', `/employees/${employee.id}/preview`, { body: input });
    expect(preview.status).toBe(200);
    expect(
      ((await preview.json()) as { customFields: Record<string, unknown> }).customFields[field.id] ?? null,
    ).toBeNull();
    const hired = await session.business(employee.id, input, employee.revision);
    expect(hired.status).toBe('effective');
    expect(hired.record).not.toBeNull();
    expect(hired.record?.customFields[field.id] ?? null).toBeNull();
    expect(hired.record?.fields.place ?? null).toBeNull();
    expect(hired.record?.fields.remarks ?? null).toBeNull();
  });

  it.each([
    { ending: 'leave', entering: 'rehire' },
    { ending: 'retirement', entering: 'retire_rehire' },
  ])('$entering开启新周期，标准和自定义字段都不从上一周期继承', async ({ ending, entering }) => {
    const fixture = await inheritanceFixture(testDb().db, `inherit-cycle-${entering}`);
    const ended = await fixture.business(
      fixture.employee.id,
      { kind: ending, mode: 'direct', lastWorkDate: '2026-01-31' },
      fixture.hired.employeeRevision,
    );
    const rehired = await fixture.business(
      fixture.employee.id,
      { kind: entering, mode: 'direct', effectiveDate: '2026-03-01', formId: 'readonly-custom' },
      ended.employeeRevision,
    );
    expect(rehired.record?.staffId).not.toBe(fixture.hired.record?.staffId);
    expect(rehired.record?.entryDate).toBe('2026-03-01');
    expect(rehired.record?.customFields[fixture.field.id] ?? null).toBeNull();
    expect(rehired.record?.fields.place ?? null).toBeNull();
    expect(rehired.record?.fields.remarks ?? null).toBeNull();
  });
});

describe('REQ-EMP-002 生效时继承与服务端表单配置', () => {
  it.each([
    { formId: 'standard', expected: '生效前新增任职值' },
    { formId: 'omitted-custom', expected: '生效前新增任职值' },
  ])('$formId：拖出字段先按值匹配更新，未拖出字段到实际生效才取最新前驱', async ({ formId, expected }) => {
    const { db } = testDb();
    const fixture = await inheritanceFixture(db, `inherit-deferred-${formId}`);
    // R1-T07：提交申请须匹配已发布流程（DEC-017）；此处只验证继承，安装兜底流程。
    await installApprovalFallbacks(db, fixture.tenant.id, fixture.user.id);
    const draft = await fixture.business(
      fixture.employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-12-01', formId },
      fixture.hired.employeeRevision,
    );
    expect(draft).toMatchObject({ status: 'draft', record: null });
    const interim = await fixture.business(
      fixture.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-01',
        customFields: { [fixture.field.id]: '生效前新增任职值' },
      },
      draft.employeeRevision,
    );
    expect(interim.record?.customFields[fixture.field.id]).toBe('生效前新增任职值');
    // R1-T06 向后更新会增加目标业务 revision；必须刷新后显式提交。
    const latest = (await (await fixture.request('GET', `/businesses/${draft.id}`)).json()) as EmploymentBusiness;
    const submitted = await fixture.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: latest.revision });
    expect(submitted.status).toBe(200);
    const inReview = (await submitted.json()) as EmploymentBusiness;
    const approved = await trustedTransition(db, fixture, inReview, 'approve', '2026-10-01T01:00:00Z');
    expect(approved).toMatchObject({ status: 'approved', record: null });
    const effective = await trustedTransition(db, fixture, approved, 'activate', '2026-12-01T01:00:00Z');
    expect(effective).toMatchObject({ status: 'effective' });
    expect(effective.record?.customFields[fixture.field.id]).toBe(expected);
    expect(effective.record?.previousRecordId).toBe(interim.record?.id);
  });

  it('AC-EMP-10 未分组表单不显示默认值，最终任职仍按服务端继承规则赋值', async () => {
    const fixture = await inheritanceFixture(testDb().db, 'inherit-ungrouped');
    const body = { kind: 'transfer', mode: 'direct', effectiveDate: '2026-02-01', formId: 'ungrouped-custom' };
    const preview = await fixture.request('POST', `/employees/${fixture.employee.id}/preview`, { body });
    expect(preview.status).toBe(200);
    const defaults = (await preview.json()) as {
      fields: Record<string, unknown>;
      customFields: Record<string, unknown>;
    };
    expect(defaults.fields.place ?? null).toBeNull();
    expect(defaults.customFields[fixture.field.id] ?? null).toBeNull();
    const created = await fixture.business(fixture.employee.id, body, fixture.hired.employeeRevision);
    expect(created.record?.customFields[fixture.field.id]).toBe('上一任职字段值');
    expect(created.record?.fields.place).toBe('上一任职工作地');
  });

  it.each(['readonly-custom', 'hidden-custom', 'omitted-custom'])('%s不接受客户端覆盖字段值', async (formId) => {
    const fixture = await inheritanceFixture(testDb().db, `inherit-edit-${formId}`, false);
    const denied = await fixture.request('POST', `/employees/${fixture.employee.id}/businesses`, {
      ifMatch: fixture.hired.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-02-01',
        formId,
        customFields: { [fixture.field.id]: '客户端不应写入的值' },
      },
    });
    expect([400, 403]).toContain(denied.status);
    const records = await fixture.records(fixture.employee.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.customFields[fixture.field.id]).toBe('上一任职字段值');
  });

  it('字段展示和可编辑性来自服务端配置，客户端伪造元数据被拒绝', async () => {
    const fixture = await inheritanceFixture(testDb().db, 'inherit-client-metadata', false);
    const denied = await fixture.request('POST', `/employees/${fixture.employee.id}/businesses`, {
      ifMatch: fixture.hired.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-02-01',
        formId: 'hidden-custom',
        fieldVisibility: { [fixture.field.id]: 'editable' },
        inherit: { [fixture.field.id]: false },
        customFields: { [fixture.field.id]: '伪造配置值' },
      },
    });
    expect(denied.status).toBe(400);
    expect(await fixture.records(fixture.employee.id)).toHaveLength(1);
  });
});
