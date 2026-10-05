/** PR-A：DEC-150 / DEC-154 保存校验，以及 AC-TRF-34 同日主职业务的既有版本链复用。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function disableTarget(w: ActivationWorld, date: string) {
  const response = await tenantApi(w.db).request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: w.to.revision,
    body: { enabled: false, effectiveDate: date },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function businessCount(w: ActivationWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS count FROM employment_business_objects
      WHERE tenant_id=${w.session.tenant.id} AND employee_id=${employeeId}::uuid`);
    const rows = (Array.isArray(result) ? result : (result as { rows: { count: number }[] }).rows) as {
      count: number;
    }[];
    return rows[0]!.count;
  });
}

describe('AC-TRF 保存校验 DEC-150 / DEC-154', () => {
  it.each(['direct', 'application'] as const)(
    'DEC-150：%s 调动日启用、以后已排定停用，仍拒绝保存且整笔回滚',
    async (mode) => {
      const w = await activationWorld(testDb().db, `trf150-${mode}`);
      const { employee, hire } = await w.hired();
      await disableTarget(w, '2026-10-10');
      const before = await businessCount(w, employee.id);
      const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: hire.employeeRevision,
        body: { kind: 'transfer', mode, effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          message: '任职部门【调入部门】已被停用（停用日期：2026-10-10），请检查',
        },
      });
      expect(await businessCount(w, employee.id)).toBe(before);
      expect((await w.session.getEmployee(employee.id)).revision).toBe(hire.employeeRevision);
      expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(1);
    },
  );

  it.each(['2026-10-05', '2026-10-01'])('DEC-150：开始日当天或之前（%s）停用也给出原站提示', async (date) => {
    const w = await activationWorld(testDb().db, `trf150-disabled-${date}`);
    const { employee, hire } = await w.hired();
    await disableTarget(w, date);
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: `任职部门【调入部门】已被停用（停用日期：${date}），请检查` },
    });
  });

  it('DEC-150：其他新增任职业务和入职共用整个时段校验', async () => {
    const w = await activationWorld(testDb().db, 'trf150-common-write');
    const { employee, hire } = await w.hired();
    const newcomer = await w.session.employee('共享校验新员工');
    await disableTarget(w, '2026-10-10');
    for (const [id, revision, kind] of [
      [employee.id, hire.employeeRevision, 'regularization'],
      [newcomer.id, newcomer.revision, 'hire'],
    ] as const) {
      const response = await w.session.request('POST', `/employees/${id}/businesses`, {
        ifMatch: revision,
        body: {
          kind,
          mode: 'direct',
          effectiveDate: '2026-10-05',
          fields: { departmentId: w.to.id },
          ...(kind === 'hire' ? { loginEmail: `new-${id}@example.com` } : {}),
        },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: '任职部门【调入部门】已被停用（停用日期：2026-10-10），请检查' },
      });
    }
  });

  it.each([
    { restored: false, disabledOn: '2026-10-01' },
    { restored: true, disabledOn: '2026-10-03' },
  ])('DEC-150：停用后更名仍显示本次实际停用日 $disabledOn（中途复启：$restored）', async (scenario) => {
    const w = await activationWorld(testDb().db, `trf150-disable-segment-${scenario.restored}`);
    const { employee, hire } = await w.hired();
    const changes: Record<string, unknown>[] = [{ enabled: false, effectiveDate: '2026-10-01' }];
    if (scenario.restored) {
      changes.push({ enabled: true, effectiveDate: '2026-10-02' }, { enabled: false, effectiveDate: '2026-10-03' });
    }
    changes.push({ name: '停用后更名部门', effectiveDate: '2026-10-04' });
    let revision = w.to.revision;
    for (const body of changes) {
      const changed = await tenantApi(w.db).request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: revision,
        body,
      });
      expect(changed.status, await changed.clone().text()).toBe(200);
      revision = ((await changed.json()) as { revision: number }).revision;
    }
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        message: `任职部门【停用后更名部门】已被停用（停用日期：${scenario.disabledOn}），请检查`,
        details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED', disabledOn: scenario.disabledOn },
      },
    });
    expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(1);
  });

  it('DEC-150：草稿修改目标部门也拒绝已排定停用，原载荷与 revision 不变', async () => {
    const w = await activationWorld(testDb().db, 'trf150-patch');
    const { employee, hire } = await w.hired();
    const draft = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { place: '待修改' } },
      hire.employeeRevision,
    );
    await disableTarget(w, '2026-10-10');
    const response = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { departmentId: w.to.id } },
    });
    expect(response.status).toBe(400);
    expect(await w.business(draft.id)).toMatchObject({
      revision: draft.revision,
      fields: { departmentId: w.from.id, place: '待修改' },
    });
  });

  it.each(['2026-10-01', '2026-10-02'])(
    'DEC-150：%s 恢复启用后的历史停用不误拦（同日修正只取最后版本）',
    async (restoredOn) => {
      const w = await activationWorld(testDb().db, `trf150-restored-${restoredOn}`);
      const { employee, hire } = await w.hired();
      await disableTarget(w, '2026-10-01');
      const restored = await tenantApi(w.db).request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: w.to.revision + 1,
        body: { enabled: true, effectiveDate: restoredOn },
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      const transfer = await w.session.business(
        employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
        hire.employeeRevision,
      );
      expect(transfer.status).toBe('effective');
    },
  );

  it('DEC-154：审批中的调动阻止直接调动；同一员工撤回后可重新直接调动', async () => {
    const w = await activationWorld(testDb().db, 'trf154-in-review');
    const { employee } = await w.hired();
    const pending = await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id });
    const revision = (await w.session.getEmployee(employee.id)).revision;
    const before = await businessCount(w, employee.id);
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: revision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '被拒绝' } },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        message: '当前存在审批中的调动记录，无法进行此操作',
        details: { reason: 'TRANSFER_IN_REVIEW' },
      },
    });
    expect(await businessCount(w, employee.id)).toBe(before);
    expect((await w.session.getEmployee(employee.id)).revision).toBe(revision);
    const withdrawn = await w.session.request('POST', `/businesses/${pending.id}/withdraw`, {
      ifMatch: pending.revision,
      body: {},
    });
    expect(withdrawn.status).toBe(200);
    const direct = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '撤回后调动' } },
      (await w.session.getEmployee(employee.id)).revision,
    );
    expect(direct.status).toBe('effective');
  });

  it('DEC-154：别人的在途调动不拦截本员工，自己的草稿与审批通过也不误拦', async () => {
    const w = await activationWorld(testDb().db, 'trf154-boundaries');
    const first = await w.hired('在途员工');
    const second = await w.hired('可直接调动员工');
    await w.apply(first.employee.id, '2026-10-05', { departmentId: w.to.id });
    await w.session.business(
      second.employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05' },
      second.hire.employeeRevision,
    );
    const direct = await w.session.business(
      second.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '未被他人申请影响' } },
      (await w.session.getEmployee(second.employee.id)).revision,
    );
    expect(direct.status).toBe('effective');
    const approved = await w.approve(
      await w.apply(second.employee.id, '2026-10-05', { place: '审批通过' }),
      '2026-10-02T02:00:00Z',
    );
    expect(approved.status).toBe('approved');
    expect(
      (
        await w.session.business(
          second.employee.id,
          { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { place: '审批后允许' } },
          (await w.session.getEmployee(second.employee.id)).revision,
        )
      ).status,
    ).toBe('effective');
  });
});

describe('AC-TRF-34 复用 DEC-108 同日业务顺序', () => {
  it.each(['direct', 'application'] as const)('同日转正为 %s 时可提交调动，生效后排在转正后', async (mode) => {
    const w = await activationWorld(testDb().db, `trf34-${mode}`);
    const { employee, hire } = await w.hired();
    const regularization = await w.session.business(
      employee.id,
      { kind: 'regularization', mode, effectiveDate: '2026-10-05', fields: { place: '转正地点' } },
      hire.employeeRevision,
    );
    if (mode === 'application') {
      const submitted = await w.session.request('POST', `/businesses/${regularization.id}/submit`, {
        ifMatch: regularization.revision,
        body: {},
      });
      expect(submitted.status).toBe(200);
    }
    const transfer = await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, place: '调动地点' });
    await w.approve(transfer, '2026-10-02T02:00:00Z');
    if (mode === 'application') await w.approve(regularization, '2026-10-02T03:00:00Z');
    expect((await w.runScheduler('2026-10-05T02:00:00Z')).failed).toEqual([]);
    const records = await w.session.records(employee.id, '2026-10-05');
    expect(records.map((record) => record.id)).toEqual([hire.id, regularization.id, transfer.id]);
    expect(records.filter((record) => record.isCurrent)).toEqual([
      expect.objectContaining({ id: transfer.id, previousRecordId: regularization.id }),
    ]);
  });
});
