import { expect } from 'vitest';
import type { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { tenantApi } from './support/tenant-api.js';

type World = Awaited<ReturnType<typeof carriedWorld>>;
export async function configure(w: World, strictControl: boolean, count = 1, effectiveDate = '2026-10-01') {
  const target = (await w.capacities())[1]!;
  const response = await tenantApi(w.db).request('PATCH', `/api/tenant/establishment/capacities/${target.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: target.revision,
    body: {
      effectiveDate,
      strictControl,
      subdivisions: [{ positionId: w.targetPosition, localCapacity: count, inclusiveCapacity: null }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
export async function warning(response: Response, strict = false) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { details: { reason: strict ? 'ESTABLISHMENT_EXCEEDED' : 'CONFIRMATION_REQUIRED' } },
  });
}
