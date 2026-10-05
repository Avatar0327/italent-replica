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
async function fixture(conditions = false, inclusive = false) {
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
    maintenanceMode: inclusive ? 'both' : 'local',
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
    ...(inclusive ? { inclusiveCapacity: 1 } : {}),
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

it('F-017 周期内组织后来挂入目标子树，联合峰值不能使用生效日固定子树', async () => {
  const w = await fixture(false, true);
  const occupied = await w.hired('未来子组织人员');
  expect(occupied.hire.status).toBe('effective');
  const moved = await w.request(
    'PATCH',
    `org/organizations/${w.from.id}`,
    {
      effectiveDate: '2026-10-20',
      parents: { admin: { parentId: w.to.id } },
    },
    w.from.revision,
  );
  expect(moved.status, await moved.clone().text()).toBe(200);
  const other = await w.hired('调入员工');
  const rejected = await w.save(other.employee.id, w.to.id);
  expect(rejected.status, await rejected.clone().text()).toBe(409);
});
it('F-017 向后更新条件字段也检查编制；DEC-015 导入编辑保留警告并完成同一更新', async () => {
  const w = await fixture(true);
  const person = await w.hired();
  const future = await w.session.business(
    person.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-10', fields: { departmentId: w.to.id } },
    person.hire.employeeRevision,
  );
  expect(
    (
      await w.request(
        'PATCH',
        `establishment/capacities/${w.capacity.id}`,
        { localCapacity: 0, effectiveDate: '2026-10-01' },
        w.capacity.revision,
      )
    ).status,
  ).toBe(200);
  const before = await w.business(person.hire.id);
  const patch = { fields: { employmentForm: '正式' } };
  const blocked = await w.session.request('PATCH', `/records/${person.hire.id}`, {
    ifMatch: before.revision,
    body: patch,
  });
  expect(blocked.status).toBe(409);
  expect((await w.business(person.hire.id)).fields.employmentForm).toBeNull();
  expect((await w.business(future.id)).fields.employmentForm).toBeNull();
  const imported = await w.session.request('POST', `/employees/${person.employee.id}/import`, {
    ifMatch: (await w.session.getEmployee(person.employee.id)).revision,
    body: { items: [{ operation: 'edit', id: person.hire.id, revision: before.revision, patch }] },
  });
  expect(imported.status, await imported.clone().text()).toBe(200);
  expect(await imported.json()).toMatchObject({
    warnings: [{ businessId: future.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
  });
  expect((await w.business(future.id)).fields.employmentForm).toBe('正式');
});
it('F-017 同员工同日在后申请调出后，审批在前调入不能虚占编制', async () => {
  const w = await fixture();
  const person = await w.hired();
  const first = await w.apply(person.employee.id, '2026-10-10', { departmentId: w.to.id });
  await w.apply(person.employee.id, '2026-10-10', { departmentId: w.from.id });
  const other = await w.hired();
  await w.apply(other.employee.id, '2026-10-10', { departmentId: w.to.id });
  expect((await w.approve(first, '2026-10-02T01:00:00Z')).status).toBe('approved');
});
