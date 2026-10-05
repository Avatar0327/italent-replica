import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld } from './AC-APV-support.js';

const database = useTestDb();
const base = '/api/tenant/employment/transfers';
async function employeeRevision(world: Awaited<ReturnType<typeof approvalWorld>>, id: string) {
  const response = await world.request(world.hr.id, 'GET', `/api/tenant/employment/employees/${id}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { revision: number }).revision;
}

async function configureProcessForms(world: Awaited<ReturnType<typeof approvalWorld>>) {
  for (const formId of ['TenantBase.JobLevelTransferMultiFormView', 'TenantBase.Customized5TransferMultiFormView']) {
    const response = await world.request(world.hr.id, 'PUT', `${base}/forms/${formId}`, {
      ifMatch: 0,
      body: {
        name: '合成流程匹配表单',
        group: 'transfer',
        // 流程匹配场景只调整部门；其他不带出字段按真实配置只读，独立于 DEC-162 必填验收。
        fieldModes: Object.fromEntries(
          ['positionId', 'directManagerId', 'dottedManagerId', 'levelId', 'gradeId'].map((field) => [
            `preset:${field}`,
            'readonly',
          ]),
        ),
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
}

describe('AC-TRF-03：调动类型、原因与服务端流程绑定', () => {
  it('标准与 Customized5 入口分别匹配本类型流程，客户端不能指定 processCode', async () => {
    const world = await approvalWorld(database().db, 'transfer-process');
    await configureProcessForms(world);
    const department = await world.org('合成调动部门');
    const person = await world.person('合成调动人员', department);
    const standard = await world.publishedProcess({ nodes: [{ key: 'review', approver: 'owner' }] });
    const custom = await world.publishedProcess({
      priority: 1,
      conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'Customized5TransferFlow' }] },
      nodes: [{ key: 'review', approver: 'owner' }],
    });
    for (const [formId, processId] of [
      ['TenantBase.JobLevelTransferMultiFormView', standard.id],
      ['TenantBase.Customized5TransferMultiFormView', custom.id],
    ]) {
      const response = await world.request(world.hr.id, 'POST', `${base}/employees/${person.employeeId}`, {
        ifMatch: await employeeRevision(world, person.employeeId),
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
      ifMatch: await employeeRevision(world, person.employeeId),
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
    await configureProcessForms(world);
    const department = await world.org('合成部门');
    const person = await world.person('合成员工', department);
    const revision = await employeeRevision(world, person.employeeId);
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
    expect(await employeeRevision(world, person.employeeId)).toBe(revision);
    const reason = await world.request(world.hr.id, 'POST', `${base}/employees/${person.employeeId}`, {
      ifMatch: revision,
      body: { ...body, reasonCode: 'secondment', submit: false },
    });
    expect(reason.status).toBe(400);
  });
});
