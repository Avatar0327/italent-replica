import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
async function fixture(label: string, capacity = 1, occupancyRanges = [{ employmentType: 'internal' }]) {
  const w = await activationWorld(database().db, label);
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  async function request(method: string, path: string, body: object, revision = 0) {
    return api.request(method, `/api/tenant/establishment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
  }
  const schemeResponse = await request('POST', '/schemes', {
    name: '合成严格控编方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges,
  });
  expect(schemeResponse.status).toBe(201);
  const scheme = (await schemeResponse.json()) as { id: string };
  const capacityResponse = await request('POST', '/capacities', {
    orgId: w.to.id,
    schemeId: scheme.id,
    periodStart: '2026-01-01',
    localCapacity: capacity,
    strictControl: true,
  });
  expect(capacityResponse.status).toBe(201);
  const cap = (await capacityResponse.json()) as { id: string; revision: number };
  return { ...w, request, cap };
}

describe('AC-TRF-31 / DEC-145 真实任职人员与严格编制', () => {
  it('保存时已满编拒绝，非占编人员与外部人员不拦截', async () => {
    const w = await fixture('trf-est-save', 0);
    const { employee, hire } = await w.hired();
    const blocked = await w.session.request('POST', `/transfers/employees/${employee.id}`, {
      ifMatch: hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-01',
        fields: { departmentId: w.to.id },
      },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    for (const employType of ['intern', 'external']) {
      const person = await w.session.employee(`合成${employType}`);
      const hired = await w.session.business(
        person.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.from.id, employType } },
        person.revision,
      );
      const response = await w.session.request('POST', `/transfers/employees/${person.id}`, {
        ifMatch: hired.employeeRevision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'direct',
          effectiveDate: '2026-10-01',
          fields: { departmentId: w.to.id },
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
    }
  });

  it('Q-M0-15 同条件字段且/同字段值或/多条件并集，与雇佣关系匹配', async () => {
    const ranges = [
      { employmentType: 'internal', conditions: { employmentForm: ['full', 'part'], employmentType: ['engineer'] } },
      { employmentType: 'intern', conditions: { employmentSource: ['campus'] } },
    ];
    const w = await fixture('trf-est-ranges', 0, ranges);
    const { employee, hire } = await w.hired();
    const create = (fields: object) =>
      w.session.request('POST', `/transfers/employees/${employee.id}`, {
        ifMatch: hire.employeeRevision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          effectiveDate: '2026-10-01',
          fields: { departmentId: w.to.id, ...fields },
        },
      });
    expect((await create({ employmentForm: 'part', employmentType: 'engineer' })).status).toBe(409);
    expect((await create({ employmentForm: 'contract', employmentType: 'engineer' })).status).toBe(201);
  });

  it('申请通过后真实满编 → 到期失败 → 调整编制 → 按原日重试，幂等关闭待办', async () => {
    const w = await fixture('trf-est-retry');
    const { employee } = await w.hired();
    const application = await w.apply(employee.id, '2026-10-10', { departmentId: w.to.id });
    await w.approve(application, '2026-10-02T01:00:00Z');
    const occupant = await w.session.employee('合成占编人员');
    await w.session.business(
      occupant.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-10-03', fields: { departmentId: w.to.id } },
      occupant.revision,
    );
    const failed = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(failed.failed).toEqual([application.id]);
    expect(await w.business(application.id)).toMatchObject({
      status: 'approved',
      record: null,
      activation: { failureReason: 'ESTABLISHMENT_EXCEEDED', failureCount: 1 },
    });
    expect(await w.todos()).toHaveLength(1);
    const adjusted = await w.request(
      'PATCH',
      `/capacities/${w.cap.id}`,
      {
        localCapacity: 2,
        effectiveDate: '2026-10-01',
      },
      w.cap.revision,
    );
    expect(adjusted.status, await adjusted.clone().text()).toBe(200);
    const retried = await w.retry(application, '2026-10-11T01:00:00Z', 'est-retry');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await w.business(application.id)).toMatchObject({ status: 'effective', effectiveDate: '2026-10-10' });
    expect(await w.todos()).toEqual([]);
    expect((await w.runScheduler('2026-10-11T02:00:00Z')).activated).toEqual([]);
    expect(
      (await w.outboxEvents(application.id)).filter((e) => e.eventType === 'employment.record.create'),
    ).toHaveLength(1);
  });
});
