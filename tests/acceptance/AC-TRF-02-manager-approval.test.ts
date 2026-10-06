import { useTestDb } from '@italent/testkit';
import { describe, it, expect } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
describe('AC-TRF-02 经理复用审批安全', () => {
  it('真实纯经理提交匹配调动流程，发起人跳过、不能自审，待办按本人隔离', async () => {
    const w = await approvalWorld(database().db, 'manager-approval');
    const org = await w.org('经理负责组织');
    const manager = await w.person('纯经理', org);
    const employee = await w.person('组织内员工', org);
    await w.setOrgRoles(org, { head: manager.employeeId });
    const process = await w.publishedProcess({ nodes: [{ key: 'manager', approver: 'record_department_head' }] });
    const api = tenantApi(database().db, { authorize: undefined, clock: () => new Date('2026-10-01T01:00:00Z') });
    const actor = { user: manager.userId, tenant: w.tenant.id };
    const saved = await api.request('POST', `/api/tenant/employment/transfers/employees/${employee.employeeId}`, {
      ...actor,
      ifMatch: (
        (await (await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employee.employeeId}`)).json()) as {
          revision: number;
        }
      ).revision,
      body: {
        initiator: 'manager',
        transferTypeCode: 'in_department',
        effectiveDate: '2026-11-01',
        formId: 'TenantBase.TransferMultiFormView',
        mode: 'application',
        fields: { departmentId: org },
        submit: true,
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const business = (await saved.json()) as { id: string; status: string };
    expect(business.status).toBe('in_review');
    const instance = await w.instanceOf(business.id, manager.userId);
    expect(instance.processId).toBe(process.id);
    expect(instance.tasks.some((t) => t.assigneeUserId === manager.userId && t.origin === 'self_skip')).toBe(true);
    expect(instance.tasks.filter((t) => t.status === 'pending').every((t) => t.assigneeUserId !== manager.userId)).toBe(
      true,
    );
    const detail = await api.request('GET', `/api/tenant/approval/instances/${instance.id}`, actor);
    expect(detail.status, await detail.clone().text()).toBe(200);
    const view = (await detail.json()) as { form: { values: object }; actions: string[] };
    expect(view.actions).not.toContain('approve');
    expect(view.form.values).not.toHaveProperty('departmentId'); // 节点本单字段为空，身份可见不扩大本单披露。
    expect(view.form.values).not.toHaveProperty('remarks');
    const applied = await api.request('GET', '/api/tenant/employment/transfers/manager/todos?tab=initiated', actor);
    expect(await applied.json()).toMatchObject({ items: [expect.objectContaining({ id: instance.id })] });
    const generic = await api.request('POST', `/api/tenant/employment/employees/${employee.employeeId}/businesses`, {
      ...actor,
      ifMatch: (
        (await (await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employee.employeeId}`)).json()) as {
          revision: number;
        }
      ).revision,
      body: { kind: 'leave', mode: 'application', effectiveDate: '2026-12-01', lastWorkDate: '2026-11-30', fields: {} },
    });
    expect(generic.status).toBe(403);
  });
});
