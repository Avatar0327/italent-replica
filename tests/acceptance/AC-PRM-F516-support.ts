import { type Db, sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { BASE, seedPermissionWorld } from './AC-PRM-support.js';
import { hrApi, syntheticEmail } from './AC-PRM-users-support.js';
import { tenantApi } from './support/tenant-api.js';

export const F516_NOW = new Date('2026-10-01T01:00:00Z');
export type F516Row = Record<string, unknown> & { userId: string };
export async function f516World(db: Db) {
  const world = await seedPermissionWorld(db);
  const hr = hrApi(world);
  const api = tenantApi(db, { clock: () => F516_NOW });
  const call = (method: string, path: string, extra: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...world.asAdmin, ...extra });
  async function person(name: string, phone: string | null = null, email: string | null = null) {
    const employee = await hr.employee(name, syntheticEmail('f516'));
    const current = await call('GET', `/api/tenant/personnel/employees/${employee.id}`);
    const revision = ((await current.json()) as { revision: number }).revision;
    const patch = await call('PATCH', `/api/tenant/personnel/employees/${employee.id}`, {
      ifMatch: revision,
      body: { mobilePhone: phone, email },
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const links = await withTenant(db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT user_id FROM permission_user_person_links WHERE employee_id=${employee.id}::uuid`),
    );
    const userId = (Array.isArray(links) ? links : links.rows)[0]!.user_id as string;
    return { ...employee, userId };
  }
  async function page(path: string, reader = api) {
    const response = await reader.request('GET', `${BASE}${path}`, world.asAdmin);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: F516Row[]; total: number; unrecorded: string[] };
  }
  function restricted(personIds?: string[], hidden: string[] = [], canView = true) {
    const authorize = (request: { action: string; resource?: string }) =>
      !(request.action === 'object.view' && request.resource === PERSONNEL_OBJECT && !canView);
    registerScopeProvider(authorize, {
      authorize: async (request) => authorize(request),
      scope: async () => ({ ...EMPTY_SCOPE, all: personIds === undefined, personIds: personIds ?? [] }),
      fields: async (_tenant, _user, object) =>
        new Set(
          PERSONNEL_OBJECTS.find((item) => item.code === object)
            ?.fields.map((field) => field.code)
            .filter((field) => !hidden.includes(field)) ?? [],
        ),
    });
    return tenantApi(db, { authorize, clock: () => F516_NOW });
  }
  return { ...world, hr, api, call, person, page, restricted };
}
