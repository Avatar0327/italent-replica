import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

it('AC-TRF-37 带编标志进入审批值和变化字段，受字段授权与盲审规则控制', async () => {
  const w = await carriedWorld(database().db, 'carried-approval-field');
  const response = await w.save(await w.hired(), { mode: 'application' });
  expect(response.status).toBe(201);
  const business = (await response.json()) as { id: string; revision: number };
  const snapshot = await withTenant(w.db, w.session.tenant.id, (tx) =>
    ADAPTERS.employment.snapshot(
      tx,
      {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: w.session.tenant.timezone,
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: business.revision,
      },
      business.id,
    ),
  );
  expect(snapshot.values.withEstablishment).toBe(true);
  expect(snapshot.changedFields).toContain('withEstablishment');
  expect(MODULE_OBJECTS.employmentRecord.fields).toContainEqual({ code: 'withEstablishment', system: false });
});

it('AC-TRF-37 无带编字段编辑权时拒绝整个请求，不调编', async () => {
  const w = await carriedWorld(database().db, 'carried-write-denied');
  const person = await w.hired();
  const api = tenantApi(w.db, {
    clock: () => new Date('2026-10-01T01:00:00Z'),
    authorize: (request) => !(request.action === 'object.create' && request.fields?.includes('withEstablishment')),
  });
  const response = await api.request('POST', `/api/tenant/employment/transfers/employees/${person.employee.id}`, {
    tenant: w.session.tenant.id,
    user: w.session.user.id,
    ifMatch: person.hire.employeeRevision,
    body: {
      initiator: 'hr',
      transferTypeCode: 'cross_department',
      mode: 'direct',
      effectiveDate: '2026-10-05',
      withEstablishment: true,
      fields: { departmentId: w.to.id, positionId: w.targetPosition },
    },
  });
  expect(response.status).toBe(403);
  expect(await w.history()).toEqual([]);
});
