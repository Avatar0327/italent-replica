import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';

const database = useTestDb();
async function world(strict: boolean) {
  const w = await carriedWorld(database().db, 'edit-confirmation');
  await configure(w, strict);
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false })).status).toBe(201);
  const saved = await w.save(b, {
    withEstablishment: false,
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const { id, revision } = (await saved.json()) as { id: string; revision: number };
  const record = { id, revision };
  return { ...w, b, record, patch: { fields: { departmentId: w.to.id, positionId: w.targetPosition } } };
}

it.each([false, true])('AC-EST-28 单条编辑缺省要求确认且严格不可绕过 strict=%s', async (strict) => {
  const w = await world(strict);
  const before = await w.session.record(w.record.id);
  const employee = await w.session.getEmployee(w.b.employee.id);
  const request = (confirmed?: boolean) =>
    w.session.request('PATCH', `/records/${w.record.id}`, {
      ifMatch: w.record.revision,
      body: { ...w.patch, ...(confirmed === undefined ? {} : { confirmed }) },
    });
  await warning(await request(), strict);
  expect(await w.session.record(w.record.id)).toEqual(before);
  expect(await w.session.getEmployee(w.b.employee.id)).toEqual(employee);
  const confirmed = await request(true);
  if (strict) {
    await warning(confirmed, true);
    expect(await w.session.record(w.record.id)).toEqual(before);
  } else {
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await w.session.record(w.record.id)).fields).toMatchObject(w.patch.fields);
  }
});

for (const strict of [false, true])
  for (const entry of ['import', 'batch-edit'] as const)
    it(`AC-EST-28 DEC-015 ${entry} 显式返回超编行警告 strict=${strict}`, async () => {
      const w = await world(strict);
      const response =
        entry === 'import'
          ? await w.session.request('POST', `/employees/${w.b.employee.id}/import`, {
              ifMatch: (await w.session.getEmployee(w.b.employee.id)).revision,
              body: { items: [{ operation: 'edit', ...w.record, patch: w.patch }] },
            })
          : await w.session.request('POST', '/records/batch-edit', {
              ifMatch: 0,
              body: { items: [w.record], patch: w.patch },
            });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        warnings: [{ businessId: w.record.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
      });
      expect((await w.session.record(w.record.id)).fields).toMatchObject(w.patch.fields);
    });

it.each([false, true])('AC-EST-28 删除调出恢复占编也须确认 strict=%s', async (strict) => {
  const w = await carriedWorld(database().db, 'delete-confirmation');
  await configure(w, strict);
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01' })).status).toBe(201);
  const outgoing = await w.save(a, {
    withEstablishment: false,
    effectiveDate: '2026-10-05',
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(outgoing.status, await outgoing.clone().text()).toBe(201);
  const record = (await outgoing.json()) as { id: string; revision: number };
  expect((await w.save(b, { withEstablishment: false })).status).toBe(201);
  const before = await w.session.records(a.employee.id);
  const request = (confirmed?: boolean) =>
    w.session.request('DELETE', `/businesses/${record.id}`, {
      ifMatch: record.revision,
      body: confirmed === undefined ? {} : { confirmed },
    });
  await warning(await request(), strict);
  expect(await w.session.records(a.employee.id)).toEqual(before);
  const confirmed = await request(true);
  if (strict) await warning(confirmed, true);
  else {
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await w.business(record.id)).status).toBe('deleted');
  }
});
