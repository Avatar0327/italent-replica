import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('AC-TRF F-017 表单来源、在途拦截与生效日期', () => {
  it('DEC-182 已批准未生效申请拒绝直接调动并保留生效日期提示', async () => {
    const w = await activationWorld(database().db, 'f017-approved');
    const person = await w.hired();
    await w.approve(await w.apply(person.employee.id, '2026-10-10', { departmentId: w.to.id }), '2026-10-01T01:00:00Z');
    const employee = await w.session.getEmployee(person.employee.id);
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.from.id } },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: '当前存在未生效的调动记录（生效日期：2026-10-10），无法进行此操作' },
    });
    expect(await w.session.records(employee.id)).toHaveLength(1);
  });

  it('草稿只改部门时重算派生经理，显式经理仍可覆盖', async () => {
    const w = await activationWorld(database().db, 'f017-derived');
    const first = await w.hired('负责人甲');
    const second = await w.hired('负责人乙');
    const person = await w.hired();
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    for (const [org, manager] of [
      [w.from, first],
      [w.to, second],
    ] as const) {
      const response = await api.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: org.revision,
        body: { effectiveDate: '2026-10-01', personInChargeId: manager.employee.id },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const saved = await w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
      ifMatch: person.hire.employeeRevision,
      body: {
        initiator: 'hr',
        mode: 'application',
        transferTypeCode: 'cross_department',
        effectiveDate: '2026-10-01',
        fields: { departmentId: w.from.id },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const draft = (await saved.json()) as { id: string; revision: number; fields: { directManagerId: string } };
    expect(draft.fields.directManagerId).toBe(first.employee.id);
    const edited = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { departmentId: w.to.id } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ fields: { directManagerId: second.employee.id } });
  });

  it('新增下属的任职早于经理入职，按联动日校验新经理', async () => {
    const w = await activationWorld(database().db, 'f017-manager-date');
    const subordinate = await w.hired('先入职的下属');
    const employee = await w.session.employee('后入职的经理');
    const hire = await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-20', fields: { departmentId: w.from.id } },
      employee.revision,
    );
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { departmentId: w.to.id, addedSubordinateIds: [subordinate.employee.id] },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await w.business(subordinate.hire.id)).fields.directManagerId).toBe(employee.id);
  });

  it('DEC-186 调度迟到时任职改为执行日，原计划日保留审计', async () => {
    const w = await activationWorld(database().db, 'f017-late');
    const person = await w.hired();
    const business = await w.approve(
      await w.apply(person.employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-01T01:00:00Z',
    );
    expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    expect(await w.business(business.id)).toMatchObject({ effectiveDate: '2026-10-08', status: 'effective' });
    const events = await w.auditEvents(business.id);
    expect(events.some((event) => event.after?.originalEffectiveDate === '2026-10-05')).toBe(true);
  });
});

it('F-017 DEC-185 补全后永久关闭，再清空生成新的员工字段待办', async () => {
  const w = await activationWorld(database().db, 'f017-completion-close');
  const person = await w.hired();
  const manager = await w.hired('补全经理');
  const response = await w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
    ifMatch: person.hire.employeeRevision,
    body: {
      initiator: 'hr',
      mode: 'direct',
      transferTypeCode: 'cross_department',
      effectiveDate: '2026-10-01',
      fields: { departmentId: w.to.id, directManagerId: null },
    },
  });
  expect(response.status).toBe(201);
  const business = (await response.json()) as { id: string; revision: number };
  const edit = async (directManagerId: string | null) => {
    const current = await w.business(business.id);
    const edited = await w.session.request('PATCH', `/records/${business.id}`, {
      ifMatch: current.revision,
      body: { fields: { directManagerId } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
  };
  await edit(manager.employee.id);
  await edit(null);
  const events = await w.auditEvents(business.id);
  const opened = events.filter(
    (event) => event.action === 'employment.completion.opened' && event.after?.fieldCode === 'preset:directManagerId',
  );
  expect(opened).toHaveLength(2);
  expect(new Set(opened.map((event) => event.after?.todoId)).size).toBe(2);
  expect(events.some((event) => event.action === 'employment.completion.closed')).toBe(true);
});

it.each([false, true])('DEC-186 直接未来调动迟到且店长联动=%s：时间轴和联动采用执行日', async (linked) => {
  const w = await activationWorld(database().db, `f017-direct-late-${linked}`);
  const person = await w.hired();
  const direct = await w.session.business(
    person.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { departmentId: w.to.id, isStoreManager: linked },
    },
    person.hire.employeeRevision,
  );
  const result = await w.runScheduler('2026-10-08T01:00:00Z');
  expect(result).toMatchObject({ failed: [], errors: [] });
  const latest = await w.business(direct.id);
  expect(latest).toMatchObject({ effectiveDate: '2026-10-08', record: { effectiveDate: '2026-10-08' } });
  expect(latest.revision).toBeGreaterThan(direct.revision);
  expect((await w.session.records(person.employee.id, '2026-10-06')).find((r) => r.isCurrent)?.id).toBe(person.hire.id);
  const events = await w.auditEvents(direct.id);
  expect(events.filter((e) => e.action === 'employment.transfer.rescheduled')).toHaveLength(1);
  if (linked)
    expect(events.find((e) => e.action === 'employment.transfer.linked')?.after).toMatchObject({
      effectiveDate: '2026-10-08',
    });
  expect((await w.runScheduler('2026-10-09T01:00:00Z')).errors).toEqual([]);
  expect((await w.business(direct.id)).effectiveDate).toBe('2026-10-08');
});
