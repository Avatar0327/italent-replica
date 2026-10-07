import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

it('AC-EST-24 范围外编制只给通用提示；确认和重放都复查当前员工范围', async () => {
  const w = await carriedWorld(database().db, 'overlap-scope');
  await configure(w, false);
  expect((await w.save(await w.hired('甲'), { withEstablishment: false, effectiveDate: '2026-10-20' })).status).toBe(
    201,
  );
  const second = await w.hired('乙');
  let revoked = false;
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    authorize: async (request) => authorize(request),
    scope: async (query) => {
      const orgIds = revoked || query.objectCode === MODULE_OBJECTS.establishment.code ? [] : [w.from.id];
      return {
        ...EMPTY_SCOPE,
        hasDataPermission: orgIds.length > 0,
        orgIds,
        terms: orgIds.length ? [{ dimension: 'organization', orgIds, personIds: [] }] : [],
      };
    },
    fields: async () => new Set(['id', 'revision', 'status']),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
  const request = (confirmed = false, key = randomUUID()) =>
    api.request('POST', `/api/tenant/employment/transfers/employees/${second.employee.id.toUpperCase()}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: second.hire.employeeRevision,
      idempotencyKey: key,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id.toUpperCase(), positionId: w.targetPosition.toUpperCase() },
        confirmed,
      },
    });
  const response = await request();
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: 'CONFLICT',
      message: '已超出设定编制，请确认后继续',
      details: { reason: 'CONFIRMATION_REQUIRED', warnings: [{ reason: 'ESTABLISHMENT_EXCEEDED' }] },
    },
  });
  revoked = true;
  expect([403, 404]).toContain((await request(true)).status);
  revoked = false;
  const key = randomUUID();
  const saved = await request(true, key);
  expect(saved.status, await saved.clone().text()).toBe(201);
  const value = await saved.json();
  expect(value).toMatchObject({ fields: {}, record: { fields: {} } });
  const serialized = JSON.stringify(value);
  for (const secret of [w.to.id, w.targetPosition, 'localCapacity', 'inclusiveCapacity'])
    expect(serialized).not.toContain(secret);
  const before = await w.session.getEmployee(second.employee.id);
  const replay = await request(true, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(value);
  expect((await w.session.getEmployee(second.employee.id)).revision).toBe(before.revision);
  revoked = true;
  expect([403, 404]).toContain((await request(true, key)).status);
});

it('AC-EST-24 提示后改为严格控制，confirmed 不绕过锁内重算', async () => {
  const w = await carriedWorld(database().db, 'overlap-recheck');
  await configure(w, false);
  expect((await w.save(await w.hired('甲'), { withEstablishment: false })).status).toBe(201);
  const second = await w.hired('乙');
  await warning(await w.save(second, { withEstablishment: false }));
  await configure(w, true);
  await warning(await w.save(second, { withEstablishment: false, confirmed: true }), true);
});
