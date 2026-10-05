import type * as Crypto from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();
const prefix = vi.hoisted(() => ({ value: '' }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>();
  return {
    ...actual,
    randomUUID: () => {
      const id = actual.randomUUID();
      return prefix.value ? prefix.value + id.slice(8) : id;
    },
  };
});
async function fixture(conditions = false) {
  const w = await activationWorld(database().db, 'f017-projection');
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const request = (method: string, path: string, body: object, revision = 0) =>
    api.request(method, `/api/tenant/${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
  const schemeResponse = await request('POST', 'establishment/schemes', {
    name: '条件编制',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges: [
      { employmentType: 'internal', ...(conditions ? { conditions: { employmentForm: ['正式'] } } : {}) },
    ],
  });
  expect(schemeResponse.status).toBe(201);
  const scheme = (await schemeResponse.json()) as { id: string };
  const capacityResponse = await request('POST', 'establishment/capacities', {
    orgId: w.to.id,
    schemeId: scheme.id,
    periodStart: '2026-01-01',
    localCapacity: 1,
    strictControl: true,
  });
  expect(capacityResponse.status).toBe(201);
  const capacity = (await capacityResponse.json()) as { id: string; revision: number };
  const save = async (employeeId: string, departmentId: string, formId = 'standard') => {
    const employee = await w.session.getEmployee(employeeId);
    return w.session.request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-10', formId, fields: { departmentId } },
    });
  };
  return { ...w, request, capacity, save };
}
it('F-017 DEC-108 同日多申请用提交顺序，UUID 逆序也不能漏算最后调入', async () => {
  const w = await fixture();
  const person = await w.hired();
  prefix.value = 'ffffff01';
  const first = await w.apply(person.employee.id, '2026-10-10', { departmentId: w.from.id });
  prefix.value = '00000001';
  const last = await w.apply(person.employee.id, '2026-10-10', { departmentId: w.to.id });
  prefix.value = '';
  expect(first.id > last.id).toBe(true);
  const other = await w.hired('另一个人');
  const rejected = await w.save(other.employee.id, w.to.id);
  expect(rejected.status, await rejected.clone().text()).toBe(409);
});
it('F-017 冻结表单 absent 字段按前驱继承后参与控编条件', async () => {
  const w = await fixture(true);
  const person = await w.hired();
  const updated = await w.session.request('PATCH', `/records/${person.hire.id}`, {
    ifMatch: person.hire.revision,
    body: { fields: { employmentForm: '正式' } },
  });
  expect(updated.status).toBe(200);
  const configured = await w.request('PUT', 'employment/transfers/forms/f017-absent', {
    name: '冻结继承表单',
    group: 'transfer',
    fieldModes: { 'preset:employmentForm': 'absent' },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);
  const pending = await w.save(person.employee.id, w.to.id, 'f017-absent');
  expect(pending.status).toBe(201);
  const draft = (await pending.json()) as { id: string; revision: number };
  expect(
    (await w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} })).status,
  ).toBe(200);
  const other = await w.hired();
  const revised = await w.session.request('PATCH', `/records/${other.hire.id}`, {
    ifMatch: other.hire.revision,
    body: { fields: { employmentForm: '正式' } },
  });
  expect(revised.status).toBe(200);
  const rejected = await w.save(other.employee.id, w.to.id);
  expect(rejected.status, await rejected.clone().text()).toBe(409);
});
it('F-017 未来审批通过占编时重新检查容量，拒绝时仍在审批中', async () => {
  const w = await fixture();
  const person = await w.hired();
  const submitted = await w.apply(person.employee.id, '2026-10-10', { departmentId: w.to.id });
  const lowered = await w.request(
    'PATCH',
    `establishment/capacities/${w.capacity.id}`,
    { localCapacity: 0, effectiveDate: '2026-10-01' },
    w.capacity.revision,
  );
  expect(lowered.status).toBe(200);
  await expect(w.approve(submitted, '2026-10-02T01:00:00Z')).rejects.toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'ESTABLISHMENT_EXCEEDED' },
  });
  expect((await w.business(submitted.id)).status).toBe('in_review');
});
