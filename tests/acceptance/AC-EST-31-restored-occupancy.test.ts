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

const CONFIRMED_AUDIT = 'employment.establishment.exceeded-confirmed';
const STATE_AFTER = {
  withdraw: 'draft',
  revoke: 'voided',
  delete: 'deleted',
  reject: 'rejected',
  disapprove: 'disapproved',
} as const;

for (const strict of [false, true])
  for (const action of ['withdraw', 'revoke', 'delete', 'reject', 'disapprove'] as const)
    it(`AC-EST-31 普通调出申请 ${action} 恢复原部门未来占编只确认不拦截 strict=${strict}`, async () => {
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
      const state = async () => ({
        business: (await w.business(business.id)).status,
        records: await w.session.records(w.a.employee.id),
        employee: await w.session.getEmployee(w.a.employee.id),
        occupant: await w.session.records(w.b.employee.id),
        audit: (await w.auditEvents(business.id)).map((event) => event.action),
        outbox: await w.outboxEvents(business.id),
      });
      const before = await state();
      // DEC-258：严格与非严格都只要求确认；驳回 / 不同意是可信审批端口，确认同样经参数透传。
      if (action === 'reject' || action === 'disapprove') {
        const run = (confirmed?: boolean) =>
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
            { id: business.id, action, ...(confirmed === undefined ? {} : { confirmed }) },
          );
        await expect(run()).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'CONFIRMATION_REQUIRED' } });
        expect(await state()).toEqual(before);
        expect((await run(true)).status).toBe(200);
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
        await warning(await request(), false);
        expect(await state()).toEqual(before);
        const response = await request(true);
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const after = await state();
      expect(after.business).toBe(STATE_AFTER[action]);
      expect(after.occupant).toEqual(before.occupant);
      expect(after.audit.filter((item) => item === CONFIRMED_AUDIT)).toHaveLength(1);
      expect(after.outbox.map((item) => item.eventType)).toContain(CONFIRMED_AUDIT);
      const audit = (await w.auditEvents(business.id)).find((event) => event.action === CONFIRMED_AUDIT);
      expect(audit?.after).toMatchObject({ reason: 'ESTABLISHMENT_EXCEEDED', action, strictControl: strict });
    });

it.each([false, true])('AC-EST-31 未预减原部门的撤回不误报原有超编 strict=%s', async (strict) => {
  const w = await carriedWorld(database().db, 'cancel-no-release');
  await configure(w, strict);
  const response = await tenantApi(w.db).request('PUT', '/api/tenant/establishment/settings', {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: 0,
    body: { effectiveDate: '2026-10-01', transferIn: 'submitted', transferOut: 'approved' },
  });
  expect(response.status).toBe(200);
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01' })).status).toBe(201);
  const outgoing = await w.save(a, {
    withEstablishment: false,
    mode: 'application',
    submit: true,
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(outgoing.status, await outgoing.clone().text()).toBe(201);
  const business = (await outgoing.json()) as { id: string; revision: number };
  const imported = await w.session.request('POST', `/employees/${b.employee.id}/import`, {
    ifMatch: (await w.session.getEmployee(b.employee.id)).revision,
    body: {
      items: [
        {
          operation: 'create',
          business: {
            kind: 'transfer',
            mode: 'direct',
            effectiveDate: '2026-10-05',
            fields: { departmentId: w.to.id, positionId: w.targetPosition },
          },
        },
      ],
    },
  });
  expect(imported.status, await imported.clone().text()).toBe(200);
  expect(await imported.json()).toMatchObject({ warnings: [{ reason: 'ESTABLISHMENT_EXCEEDED' }] });
  const withdrawn = await w.session.request('POST', `/businesses/${business.id}/withdraw`, {
    ifMatch: business.revision,
    body: {},
  });
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
  expect((await w.business(business.id)).status).toBe('draft');
});

it.each([false, true])('AC-EST-31 删除离职恢复相同部门的占编 strict=%s', async (strict) => {
  const w = await world(strict);
  const leave = await w.session.business(
    w.a.employee.id,
    {
      kind: 'leave',
      mode: 'direct',
      lastWorkDate: '2026-10-04',
    },
    (await w.session.getEmployee(w.a.employee.id)).revision,
  );
  expect((await w.save(w.b, { withEstablishment: false, fields: w.fields })).status).toBe(201);
  const employee = await w.session.getEmployee(w.a.employee.id);
  const before = await w.session.records(w.a.employee.id);
  const request = (confirmed?: boolean) =>
    w.session.request('DELETE', `/businesses/${leave.id}`, {
      ifMatch: leave.revision,
      body: confirmed === undefined ? {} : { confirmed },
    });
  await warning(await request(), strict);
  expect(await w.session.records(w.a.employee.id)).toEqual(before);
  expect(await w.session.getEmployee(w.a.employee.id)).toEqual(employee);
  const confirmed = await request(true);
  if (strict) await warning(confirmed, true);
  else expect(confirmed.status, await confirmed.clone().text()).toBe(200);
});
