import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';
export const configBody = () => ({
  code: randomUUID(),
  name: '青年人才',
  rules: {
    expression: '1',
    rows: [
      {
        rowNo: 1,
        kind: 'field',
        field: { object: 'employee', code: 'age', path: 'employee.age', kind: 'number' },
        operator: 'lt',
        values: [35],
      },
    ],
  },
});
export interface Population {
  id: string;
  revision: number;
  name: string;
  code: string;
  rules: unknown;
}
export async function configWorld(db: Db) {
  const w = await seedPermissionWorld(db);
  const api = tenantApi(db);
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/succession${path}`, {
      ...w.asAdmin,
      ...(method === 'POST' && path === '/populations' ? { ifMatch: 0 } : {}),
      ...options,
    });
  const create = async () => {
    const response = await request('POST', '/populations', { body: configBody() });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Population;
  };
  return { ...w, request, create, raw: api };
}
