import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

it('AC-ORG-27 保存前在途提示不拦截；迟到调动按 DEC-195 插在同日组织调整之前', async () => {
  const w = await activationWorld(database().db, 'org27');
  const person = await w.hired();
  const pending = await w.approve(
    await w.apply(person.employee.id, '2026-10-05', { place: '迟到调动' }),
    '2026-10-01T02:00:00Z',
  );
  const later = await w.apply(person.employee.id, '2026-10-15', { remarks: '后续申请' });
  const api = tenantApi(database().db, { clock: () => new Date('2026-10-01T02:00:00Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  const record = await w.session.record(person.hire.id);
  const id = record.fields.departmentId as string;
  const org = await api.request('GET', `/api/tenant/org/organizations/${id}`, as);
  const original = (await org.json()) as { revision: number };
  const body = { name: '在途组织新名', effectiveDate: '2026-10-09', addEmployment: true };
  const preview = await api.request('POST', `/api/tenant/org/organizations/${id}/employment-preview`, { ...as, body });
  expect(preview.status, await preview.clone().text()).toBe(200);
  expect(await preview.json()).toMatchObject({ hasPendingEmployment: true });
  expect((await w.session.records(person.employee.id)).map((r) => r.id)).toEqual([person.hire.id]);
  const save = await api.request('PATCH', `/api/tenant/org/organizations/${id}`, {
    ...as,
    body,
    ifMatch: original.revision,
  });
  expect(save.status, await save.clone().text()).toBe(200);
  expect((await w.business(later.id)).effectiveDate).toBe('2026-10-15');
  const adjustment = (await w.session.records(person.employee.id, '2026-10-09')).find(
    (r) => r.kind === 'org_adjustment',
  )!;
  expect(await w.runScheduler('2026-10-09T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.session.records(person.employee.id, '2026-10-09')).map((r) => r.id)).toEqual([
    person.hire.id,
    pending.id,
    adjustment.id,
  ]);
  expect(await w.business(pending.id)).toMatchObject({ effectiveDate: '2026-10-09', status: 'effective' });
});

it('AC-ORG-27 已保存的未来任职按日期提示；晚于变更日的不提示，预检不写库', async () => {
  const w = await activationWorld(database().db, 'org27future');
  const person = await w.hired();
  await w.session.business(
    person.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      fields: { place: '未来地点' },
    },
    person.hire.employeeRevision,
  );
  const api = tenantApi(database().db, { clock: () => new Date('2026-10-01T02:00:00Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  for (const [date, expected] of [
    ['2026-10-04', false],
    ['2026-10-08', true],
  ] as const) {
    const result = await api.request('POST', `/api/tenant/org/organizations/${w.from.id}/employment-preview`, {
      ...as,
      body: { name: '预检改名', effectiveDate: date, addEmployment: true },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ hasPendingEmployment: expected });
  }
  expect(await w.session.records(person.employee.id)).toHaveLength(2);
});
