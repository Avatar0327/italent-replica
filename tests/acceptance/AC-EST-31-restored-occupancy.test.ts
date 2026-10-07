import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { tenantApi } from './support/tenant-api.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';

const database = useTestDb();
async function world(strict: boolean) {
  const w = await carriedWorld(database().db, 'restore-conditions');
  await configure(w, strict);
  const api = tenantApi(w.db);
  const auth = { user: w.session.user.id, tenant: w.session.tenant.id };
  for (const [effectiveDate, conditions] of [
    ['2026-10-01', { dimension2: ['never'] }],
    ['2026-10-15', { dimension1: ['counted'] }],
  ] as const) {
    const current = await api.request('GET', `/api/tenant/establishment/schemes/${w.scheme.id}`, auth);
    const { revision } = (await current.json()) as { revision: number };
    const response = await api.request('PATCH', `/api/tenant/establishment/schemes/${w.scheme.id}`, {
      ...auth,
      ifMatch: revision,
      body: { effectiveDate, occupancyRanges: [{ employmentType: 'internal', conditions }] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  const fields = { departmentId: w.to.id, positionId: w.targetPosition, dimension1: 'counted' };
  const first = await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01', fields });
  expect(first.status, await first.clone().text()).toBe(201);
  return { ...w, a, b, fields };
}

it.each([false, true])('AC-EST-31 删除同部门记录恢复未来占编条件 strict=%s', async (strict) => {
  const w = await world(strict);
  const saved = await w.save(w.a, {
    withEstablishment: false,
    fields: { ...w.fields, dimension1: 'other' },
  });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const record = (await saved.json()) as { id: string; revision: number };
  expect((await w.save(w.b, { withEstablishment: false, fields: w.fields })).status).toBe(201);
  const before = await w.session.records(w.a.employee.id);
  const employee = await w.session.getEmployee(w.a.employee.id);
  const request = (confirmed?: boolean) =>
    w.session.request('DELETE', `/businesses/${record.id}`, {
      ifMatch: record.revision,
      body: confirmed === undefined ? {} : { confirmed },
    });
  await warning(await request(), strict);
  expect(await w.session.records(w.a.employee.id)).toEqual(before);
  expect(await w.session.getEmployee(w.a.employee.id)).toEqual(employee);
  const response = await request(true);
  if (strict) await warning(response, true);
  else expect(response.status, await response.clone().text()).toBe(200);
});

for (const strict of [false, true])
  for (const action of ['withdraw', 'revoke', 'delete', 'reject', 'disapprove'] as const)
    it(`AC-EST-31 普通调出申请 ${action} 恢复原部门未来占编 strict=${strict}`, async () => {
      const w = await world(strict);
      const saved = await w.save(w.a, {
        withEstablishment: false,
        mode: 'application',
        submit: true,
        fields: { departmentId: w.from.id, positionId: w.sourcePosition },
      });
      expect(saved.status, await saved.clone().text()).toBe(201);
      let business = (await saved.json()) as { id: string; revision: number };
      if (action === 'delete') business = await w.approve(business, '2026-10-01T01:00:00Z');
      const incoming = await w.save(w.b, { withEstablishment: false, fields: w.fields });
      expect(incoming.status, await incoming.clone().text()).toBe(201);
      const before = await w.session.records(w.a.employee.id);
      const employee = await w.session.getEmployee(w.a.employee.id);
      if (action === 'reject' || action === 'disapprove') {
        const run = () =>
          runEmploymentTransition(
            w.db,
            {
              tenantId: w.session.tenant.id,
              userId: w.session.user.id,
              timezone: w.session.tenant.timezone,
              now: new Date('2026-10-01T01:00:00Z'),
              commandId: randomUUID(),
              expectedRevision: business.revision,
            },
            { id: business.id, action },
          );
        if (strict) await expect(run()).rejects.toMatchObject({ details: { reason: 'ESTABLISHMENT_EXCEEDED' } });
        else expect((await run()).status).toBe(200);
      } else {
        const request = (confirmed?: boolean) =>
          w.session.request(
            action === 'delete' ? 'DELETE' : 'POST',
            `/businesses/${business.id}${action === 'delete' ? '' : `/${action}`}`,
            {
              ifMatch: business.revision,
              body: confirmed === undefined ? {} : { confirmed },
            },
          );
        await warning(await request(), strict);
        expect(await w.session.records(w.a.employee.id)).toEqual(before);
        expect(await w.session.getEmployee(w.a.employee.id)).toEqual(employee);
        const response = await request(true);
        if (strict) await warning(response, true);
        else expect(response.status, await response.clone().text()).toBe(200);
      }
      if (strict) {
        expect(await w.session.records(w.a.employee.id)).toEqual(before);
        expect(await w.session.getEmployee(w.a.employee.id)).toEqual(employee);
      }
    });
