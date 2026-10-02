/** AC-PRM-17: server-selected list data sources participate in real HTTP authorization. */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
it('datasource replaces entity rules and datasource seeAll still takes identity precedence', async () => {
  const w = await seedPermissionWorld(database().db);
  const clock = () => new Date('2026-10-01T01:00:00Z');
  const setup = tenantApi(w.db, { clock });
  const api = tenantApi(w.db, { authorize: undefined, clock });
  const object = MODULE_OBJECTS.organization;
  const code = `${object.code}.list`;
  const ids: string[] = [];
  for (const name of ['范围内组织', '范围外组织']) {
    const response = await setup.request('POST', '/api/tenant/org/organizations', {
      ...w.asAdmin,
      ifMatch: 0,
      body: { name, startDate: '2025-01-01', parents: { admin: { parentId: w.tenant.id } } },
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
  const user = await addMember(w, 'datasource-reader');
  const profile = await createProfile(w, 'datasource-profile');
  await setObjectPermission(
    w,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: [{ fieldCode: 'id', view: true, edit: false }],
      buttons: [],
    },
    object.code,
  );
  await makeGrantable(w, [profile.id]);
  expect((await grant(w, user.id, profile.id)).status).toBe(201);
  expect(
    (
      await w.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: ids[0], includeDescendants: false }] },
      })
    ).status,
  ).toBe(200);
  const policy = async (kind: string, rules: { dimension: string }[], revision: number) => {
    const target = kind === 'entity' ? object.code : code;
    const response = await w.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${object.code}/${kind}/${target}`,
      {
        ...w.asAdmin,
        ifMatch: revision,
        body: { rules },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const list = async () => {
    const response = await api.request('GET', '/api/tenant/org/organizations', {
      user: user.id,
      tenant: w.tenant.id,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { items: { id: string }[]; hasDataPermission: boolean };
  };
  await policy('entity', [{ dimension: 'management' }], 0);
  await policy('datasource', [], 0);
  expect(await list()).toMatchObject({ items: [], hasDataPermission: false });
  await policy('entity', [], 1);
  await policy('datasource', [{ dimension: 'management' }], 1);
  expect((await list()).items.map((row) => row.id)).toEqual([ids[0]]);
  await policy('datasource', [], 2);
  expect(
    (
      await w.api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'datasource', targetCode: code, seeAll: true },
      })
    ).status,
  ).toBe(200);
  expect((await list()).items.map((row) => row.id)).toEqual(expect.arrayContaining(ids));
  // A client cannot borrow a list-only seeAll grant for an entity/detail endpoint.
  expect(
    (
      await api.request('GET', `/api/tenant/org/organizations/${ids[1]}?dataSourceCode=${code}`, {
        user: user.id,
        tenant: w.tenant.id,
      })
    ).status,
  ).toBe(404);
});
