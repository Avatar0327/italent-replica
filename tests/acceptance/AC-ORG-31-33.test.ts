import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
function orgApi(w: ActivationWorld) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  return (method: string, path: string, body: object, revision = 0) =>
    api.request(method, `/api/tenant/${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
}
async function rename(w: ActivationWorld, org = w.from, effectiveDate = '2026-10-09') {
  const response = await orgApi(w)(
    'PATCH',
    `org/organizations/${org.id}`,
    { name: `${org.name}改名`, effectiveDate, addEmployment: true },
    org.revision,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}
async function strictCapacity(w: ActivationWorld) {
  const request = orgApi(w);
  const response = await request('POST', 'establishment/schemes', {
    name: '组织调整占编',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges: [{ employmentType: 'internal' }],
  });
  expect(response.status).toBe(201);
  const scheme = (await response.json()) as { id: string };
  const capacity = await request('POST', 'establishment/capacities', {
    orgId: w.to.id,
    schemeId: scheme.id,
    periodStart: '2026-01-01',
    localCapacity: 1,
    strictControl: true,
  });
  expect(capacity.status).toBe(201);
}

it('AC-ORG-31 已批准调动穿过组织调整继续占编，按期落地成功', async () => {
  const w = await activationWorld(database().db, 'org31');
  await strictCapacity(w);
  const jia = await w.hired('甲');
  const pending = await w.approve(
    await w.apply(jia.employee.id, '2026-10-05', { departmentId: w.to.id }),
    '2026-10-01T02:00:00Z',
  );
  await rename(w);
  const yi = await w.hired('乙');
  const rejected = await w.session.request('POST', `/employees/${yi.employee.id}/businesses`, {
    ifMatch: yi.hire.employeeRevision,
    body: {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-10-10',
      fields: { departmentId: w.to.id },
    },
  });
  expect.soft(rejected.status, await rejected.clone().text()).toBe(409);
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
    activated: [pending.id],
    failed: [],
    errors: [],
  });
  const current = (await w.session.records(jia.employee.id, '2026-10-09')).find((r) => r.isCurrent)!;
  expect(current.kind).toBe('org_adjustment');
  expect(current.fields.departmentId).toBe(w.to.id);
});

it('AC-ORG-32 直接未来调动迟到改期，同步撤回派生组织调整的提前调入结果', async () => {
  const w = await activationWorld(database().db, 'org32');
  const person = await w.hired();
  const transfer = await w.session.business(
    person.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { departmentId: w.to.id, place: '新地点' },
    },
    person.hire.employeeRevision,
  );
  await rename(w, w.to);
  const before = (await w.session.records(person.employee.id, '2026-10-09')).find((r) => r.kind === 'org_adjustment')!;
  expect(before.fields.departmentId).toBe(w.to.id);
  expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  const adjustment = (await w.session.records(person.employee.id, '2026-10-09')).find((r) => r.isCurrent)!;
  expect(adjustment.id).toBe(before.id);
  expect.soft(adjustment.fields.departmentId).toBe(w.from.id);
  expect.soft(adjustment.fields.place).toBe('原地点');
  const current = (await w.session.records(person.employee.id, '2026-10-10')).find((r) => r.isCurrent)!;
  expect(current).toMatchObject({
    id: transfer.id,
    effectiveDate: '2026-10-10',
    fields: { departmentId: w.to.id, place: '新地点' },
  });
});

it('AC-ORG-33 DEC-207 导入改名/改行政上级不新增任职，拒绝 addEmployment 未知字段', async () => {
  const w = await activationWorld(database().db, 'org33');
  const person = await w.hired();
  const before = await w.session.records(person.employee.id);
  const row = {
    sourceCode: 'ORG33',
    orgId: w.from.id,
    code: w.from.code,
    name: '导入改名',
    parentId: w.to.id,
    expectedRevision: w.from.revision,
    startDate: '2026-10-09',
  };
  const response = await orgApi(w)('POST', 'org/import', { rows: [row] });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ results: [{ orgId: w.from.id, status: 'updated' }] });
  expect(await w.session.records(person.employee.id)).toEqual(before);
  for (const addEmployment of [true, false]) {
    const invalid = await orgApi(w)('POST', 'org/import', { rows: [{ ...row, expectedRevision: 2, addEmployment }] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  }
  expect(await w.session.records(person.employee.id)).toEqual(before);
});
