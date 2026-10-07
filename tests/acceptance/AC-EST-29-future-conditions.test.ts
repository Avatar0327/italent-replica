import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
async function world(strict: boolean, forward: boolean) {
  const w = await carriedWorld(database().db, 'future-condition');
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
  if (forward) {
    const initial = await w.session.request('PATCH', `/records/${b.hire.id}`, {
      ifMatch: b.hire.revision,
      body: { fields: { dimension1: 'other' } },
    });
    expect(initial.status, await initial.clone().text()).toBe(200);
  }
  const first = await w.save(a, {
    withEstablishment: false,
    fields: { departmentId: w.to.id, positionId: w.targetPosition, dimension1: 'counted' },
  });
  expect(first.status, await first.clone().text()).toBe(201);
  const second = await w.save(b, {
    withEstablishment: false,
    fields: { departmentId: w.to.id, positionId: w.targetPosition, ...(forward ? {} : { dimension1: 'other' }) },
  });
  expect(second.status, await second.clone().text()).toBe(201);
  const { id } = (await second.json()) as { id: string };
  const edited = await w.business(forward ? b.hire.id : id);
  return { ...w, b, id, edited };
}

for (const strict of [false, true])
  for (const entry of ['record', 'forward', 'import', 'batch'] as const)
    it(`AC-EST-29 未来方案条件 ${entry} strict=${strict}`, async () => {
      const w = await world(strict, entry === 'forward');
      const before = await w.session.records(w.b.employee.id);
      const employee = await w.session.getEmployee(w.b.employee.id);
      const patch = { fields: { dimension1: 'counted' } };
      const request = (confirmed?: boolean) => {
        if (entry === 'import')
          return w.session.request('POST', `/employees/${w.b.employee.id}/import`, {
            ifMatch: employee.revision,
            body: { items: [{ operation: 'edit', id: w.edited.id, revision: w.edited.revision, patch }] },
          });
        if (entry === 'batch')
          return w.session.request('POST', '/records/batch-edit', {
            ifMatch: 0,
            body: { items: [{ id: w.edited.id, revision: w.edited.revision }], patch },
          });
        return w.session.request('PATCH', `/records/${w.edited.id}`, {
          ifMatch: w.edited.revision,
          body: { ...patch, ...(confirmed === undefined ? {} : { confirmed }) },
        });
      };
      const response = await request();
      if (entry === 'import' || entry === 'batch') {
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toMatchObject({
          warnings: [{ businessId: w.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
        });
      } else {
        await warning(response, strict);
        expect(await w.session.records(w.b.employee.id)).toEqual(before);
        expect(await w.session.getEmployee(w.b.employee.id)).toEqual(employee);
        const confirmed = await request(true);
        if (strict) {
          await warning(confirmed, true);
          expect(await w.session.records(w.b.employee.id)).toEqual(before);
          expect(await w.session.getEmployee(w.b.employee.id)).toEqual(employee);
          return;
        }
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      }
      expect((await w.session.record(w.id)).fields.dimension1).toBe('counted');
      expect((await w.session.getEmployee(w.b.employee.id)).revision).toBeGreaterThan(employee.revision);
    });
