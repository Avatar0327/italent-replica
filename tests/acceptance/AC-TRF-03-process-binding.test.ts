import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';

const database = useTestDb();
const base = '/api/tenant/employment/transfers';

describe('AC-TRF-03：调动类型、原因与服务端流程绑定', () => {
  it('标准与 Customized5 入口分别匹配本类型流程，客户端不能指定 processCode', async () => {
    const world = await approvalWorld(database().db, 'transfer-process');
    const department = await world.org('合成调动部门');
    const person = await world.person('合成调动人员', department);
    const standard = await world.publishedProcess({ nodes: [{ key: 'review', approver: 'owner' }] });
    const custom = await world.publishedProcess({
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'Customized5TransferFlow' }] },
      nodes: [{ key: 'review', approver: 'owner' }],
    });
    for (const [formId, processId] of [
      ['TenantBase.JobLevelTransferMultiFormView', standard.id],
      ['TenantBase.Customized5TransferMultiFormView', custom.id],
    ]) {
      const response = await world.request(world.hr.id, 'POST', `${base}/employees/${person.employeeId}`, {
        ifMatch: await world.revisionOf(person.employeeId),
        body: {
          initiator: 'hr',
          transferTypeCode: 'job_level',
          mode: 'application',
          effectiveDate: '2026-11-01',
          formId,
          fields: { departmentId: department },
          submit: true,
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const business = (await response.json()) as { id: string; status: string };
      expect(business.status).toBe('in_review');
      expect((await world.instanceOf(business.id)).processId).toBe(processId);
    }
    const forged = await world.request(world.hr.id, 'POST', `${base}/employees/${person.employeeId}`, {
      ifMatch: await world.revisionOf(person.employeeId),
      body: {
        initiator: 'hr',
        transferTypeCode: 'job_level',
        mode: 'application',
        effectiveDate: '2026-11-02',
        processCode: 'Customized5TransferFlow',
      },
    });
    expect(forged.status).toBe(400);
  });

  it('无匹配流程时业务、metadata与审计整体回滚；类型/原因绑定不能跨类型伪造', async () => {
    const world = await approvalWorld(database().db, 'transfer-no-flow');
    const department = await world.org('合成部门');
    const person = await world.person('合成员工', department);
    const revision = await world.revisionOf(person.employeeId);
    const body = {
      initiator: 'hr',
      transferTypeCode: 'job_level',
      mode: 'application',
      effectiveDate: '2026-11-01',
      fields: { departmentId: department },
      submit: true,
    };
    const response = await world.request(world.hr.id, 'POST', `${base}/employees/${person.employeeId}`, {
      ifMatch: revision,
      body,
    });
    expect(response.status).toBe(409);
    expect(await world.revisionOf(person.employeeId)).toBe(revision);
    const reason = await world.request(world.hr.id, 'POST', `${base}/employees/${person.employeeId}`, {
      ifMatch: revision,
      body: { ...body, reasonCode: 'secondment', submit: false },
    });
    expect(reason.status).toBe(400);
  });
});
