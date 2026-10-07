import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';

const database = useTestDb();
for (const strict of [false, true])
  for (const entry of ['record', 'import', 'batch'] as const)
    it(`AC-EST-30 已落地携编改配 ${entry} strict=${strict}`, async () => {
      const w = await carriedWorld(database().db, 'carried-reallocation');
      await configure(w, strict, 0);
      const a = await w.hired('携编甲');
      const b = await w.hired('普通乙');
      const carried = await w.save(a, { effectiveDate: '2026-10-20' });
      expect(carried.status, await carried.clone().text()).toBe(201);
      const record = (await carried.json()) as { id: string; revision: number };
      const exit = await w.session.org('普通乙后续部门', { establishedOn: '2026-01-01' });
      const outgoing = await w.save(b, {
        withEstablishment: false,
        effectiveDate: '2026-10-20',
        fields: { departmentId: exit.id, positionId: null },
      });
      expect(outgoing.status, await outgoing.clone().text()).toBe(201);
      const incoming = await w.save(b, { withEstablishment: false });
      expect(incoming.status, await incoming.clone().text()).toBe(201);
      const before = {
        records: await w.session.records(a.employee.id),
        capacities: await w.capacities(),
        history: await w.history(),
        employee: await w.session.getEmployee(a.employee.id),
      };
      const patch = { fields: { departmentId: w.from.id, positionId: w.sourcePosition } };
      const request = (confirmed?: boolean) => {
        if (entry === 'import')
          return w.session.request('POST', `/employees/${a.employee.id}/import`, {
            ifMatch: before.employee.revision,
            body: { items: [{ operation: 'edit', id: record.id, revision: record.revision, patch }] },
          });
        if (entry === 'batch')
          return w.session.request('POST', '/records/batch-edit', {
            ifMatch: 0,
            body: { items: [{ id: record.id, revision: record.revision }], patch },
          });
        return w.session.request('PATCH', `/records/${record.id}`, {
          ifMatch: record.revision,
          body: { ...patch, ...(confirmed ? { confirmed } : {}) },
        });
      };
      const response = await request();
      if (entry === 'record') {
        await warning(response, strict);
        expect({
          records: await w.session.records(a.employee.id),
          capacities: await w.capacities(),
          history: await w.history(),
          employee: await w.session.getEmployee(a.employee.id),
        }).toEqual(before);
        const confirmed = await request(true);
        if (strict) {
          await warning(confirmed, true);
          return;
        }
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
      } else {
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toMatchObject({
          warnings: [{ businessId: record.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
        });
      }
      expect((await w.capacities())[1]?.localCapacity).toBe(0);
      expect((await w.session.record(record.id)).fields.departmentId).toBe(w.from.id);
    });

it('AC-EST-30 回退只检查被调整周期，不受下一年无关超编阻挡', async () => {
  const w = await carriedWorld(database().db, 'carried-release-period');
  await configure(w, false, 0);
  const a = await w.hired('携编甲');
  const b = await w.hired('次年乙');
  const saved = await w.save(a, { mode: 'application', effectiveDate: '2026-10-20' });
  expect(saved.status).toBe(201);
  const draft = (await saved.json()) as { id: string; revision: number };
  const next = await w.write('establishment/capacities', {
    orgId: w.to.id,
    schemeId: w.scheme.id,
    periodStart: '2027-01-01',
    strictControl: true,
    subdivisions: [{ positionId: w.targetPosition, localCapacity: 0, inclusiveCapacity: null }],
  });
  expect(next.status, await next.clone().text()).toBe(201);
  const imported = await w.session.request('POST', `/employees/${b.employee.id}/import`, {
    ifMatch: (await w.session.getEmployee(b.employee.id)).revision,
    body: {
      items: [
        {
          operation: 'create',
          business: {
            kind: 'transfer',
            mode: 'direct',
            effectiveDate: '2027-01-05',
            fields: { departmentId: w.to.id, positionId: w.targetPosition },
          },
        },
      ],
    },
  });
  expect(imported.status, await imported.clone().text()).toBe(200);
  expect(await imported.json()).toMatchObject({ warnings: [{ reason: 'ESTABLISHMENT_EXCEEDED' }] });
  const response = await w.session.request('DELETE', `/businesses/${draft.id}`, { ifMatch: draft.revision, body: {} });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await w.capacities())[1]?.localCapacity).toBe(0);
});
