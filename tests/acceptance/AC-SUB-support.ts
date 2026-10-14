import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export async function personnelSession(db: Db, label = 'personnel') {
  const employment = await employmentSession(db, label);
  const employee = await employment.employee();
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { user: employment.user.id, tenant: employment.tenant.id };
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/personnel${path}`, { ...options, ...as });
  const path = (kind: string) => `/employees/${employee.id}/subsets/${kind}`;
  async function add(kind: string, body: object, options: RequestOptions = {}) {
    const response = await request('POST', path(kind), { ifMatch: 0, body, ...options });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Record<string, unknown> & { id: string; revision: number };
  }
  return { ...employment, employee, api, as, request, path, add };
}
