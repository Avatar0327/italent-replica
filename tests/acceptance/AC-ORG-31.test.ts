import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { versions } from './AC-JOB-sequence-support.js';
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
async function rename(w: ActivationWorld, org = w.from, effectiveDate = '2026-10-09', viaImport = false) {
  if (viaImport) {
    const response = await orgApi(w)('POST', 'org/import', {
      rows: [
        {
          sourceCode: org.id,
          orgId: org.id,
          code: `I${org.id.slice(0, 8)}`,
          name: `${org.name}改名`,
          parentId: w.session.tenant.id,
          expectedRevision: org.revision,
          startDate: effectiveDate,
          addEmployment: true,
        },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return;
  }
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

it.each([false, true])('AC-ORG-31 已批准调动穿过组织调整继续占编，按期落地成功（导入=%s）', async (viaImport) => {
  const w = await activationWorld(database().db, 'org31');
  await strictCapacity(w);
  const jia = await w.hired('甲');
  const pending = await w.approve(
    await w.apply(jia.employee.id, '2026-10-05', { departmentId: w.to.id }),
    '2026-10-01T02:00:00Z',
  );
  await rename(w, w.from, '2026-10-09', viaImport);
  const yi = await w.hired('乙');
  // 第 6 轮 P3：负向用例前后各读一次，证明控编拒绝没有写入任何业务数据（派发规则 §1）。
  const snapshot = async () => ({
    yi: { employee: await w.session.getEmployee(yi.employee.id), records: await w.session.records(yi.employee.id) },
    jia: { business: await w.business(pending.id), records: await w.session.records(jia.employee.id, '2026-10-09') },
    versions: await versions(w.db, w.session.tenant.id, yi.employee.id),
  });
  const before = await snapshot();
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
  expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  expect(await snapshot()).toEqual(before);
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
    activated: [pending.id],
    failed: [],
    errors: [],
  });
  const current = (await w.session.records(jia.employee.id, '2026-10-09')).find((r) => r.isCurrent)!;
  expect(current.kind).toBe('org_adjustment');
  expect(current.fields.departmentId).toBe(w.to.id);
});

it('AC-ORG-31 同员工后续已批准调出可释放组织调整之后的占编，不得虚占', async () => {
  const w = await activationWorld(database().db, 'org31out');
  await strictCapacity(w);
  const jia = await w.hired('甲');
  const finalOrg = await w.session.org('第三部门', { establishedOn: '2026-01-01' });
  const incoming = await w.approve(
    await w.apply(jia.employee.id, '2026-10-05', { departmentId: w.to.id }),
    '2026-10-01T02:00:00Z',
  );
  await rename(w);
  const outgoing = await w.approve(
    await w.apply(jia.employee.id, '2026-10-06', { departmentId: finalOrg.id }),
    '2026-10-01T02:00:00Z',
  );
  const yi = await w.hired('乙');
  const other = await w.apply(yi.employee.id, '2026-10-10', { departmentId: w.to.id });
  expect(other.status).toBe('in_review');
  expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
    activated: [incoming.id],
    failed: [],
    errors: [],
  });
  expect(await w.runScheduler('2026-10-06T01:00:00Z')).toMatchObject({
    activated: [outgoing.id],
    failed: [],
    errors: [],
  });
  expect((await w.session.records(jia.employee.id, '2026-10-09')).find((r) => r.isCurrent)?.fields.departmentId).toBe(
    finalOrg.id,
  );
});
