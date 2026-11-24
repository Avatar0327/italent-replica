import './support/exit-gate-enforced.js';
import { bootstrapTenantAdmin } from '@italent/api';
import { HR_MOVEMENT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { MOVEMENT_BASE, type MovementGroup } from './AC-HA-13b-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { retirementWorld } from './AC-RT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_S3_';
const today = '2026-10-26';

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

it('AC-FE-R2f-01/04/11 单授 B50 真实入口、候选与数据范围、月份生效口径与详情', async () => {
  const db = database().db;
  const w = await retirementWorld(db, prefix, today);
  const tenant = w.session.tenant.id;
  const asAdmin = { tenant, user: w.session.user.id };
  const org = (name: string, parent?: { id: string }) =>
    w.session.org(prefix + name, {
      establishedOn: '2025-01-01',
      ...(parent ? { parents: { admin: { parentId: parent.id } } } : {}),
    });
  const parent = await org('parent');
  const child = await org('child', parent);
  const internDept = await org('intern', parent);
  const outside = await org('outside');

  async function hire(name: string, departmentId: string, effectiveDate: string, employType = 'internal') {
    const person = await w.session.employee(prefix + name);
    const business = await w.session.business(
      person.id,
      { kind: 'hire', mode: 'direct', effectiveDate, fields: { employType, departmentId } },
      person.revision,
    );
    expect(business.status).toBe('effective');
    return person.id;
  }
  const exited = await hire('jan31', child.id, '2025-08-01');
  await w.effectiveExit(exited, '2026-01-31');
  const intern = await hire('intern_exit', internDept.id, '2026-10-01', 'intern');
  await w.effectiveExit(intern, '2026-10-20');
  await hire('out_of_scope', outside.id, '2026-02-01');

  const api = tenantApi(db, { authorize: undefined, clock: () => new Date(today + 'T01:00:00Z') });
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: tenant, userId: asAdmin.user }, cmd());
  const world = { db, api, tenant: w.session.tenant, admin: w.session.user, asAdmin, adminRecord };
  const reader = await addMember(world, prefix + 'reader');
  const denied = await addMember(world, prefix + 'denied');
  const profile = await createProfile(world, prefix + 'view');
  const permissions = { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [] };
  expect((await setObjectPermission(world, profile, permissions, HR_MOVEMENT_OBJECT)).status).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, reader.id, profile.id)).status).toBe(201);

  const who = { tenant, user: reader.id };
  const get = (path: string) => api.request('GET', path, who);
  const snapshot = await json<ServerSnapshot>(await get('/api/tenant/permission/me/snapshot'));
  expect(snapshot.apps.find(({ app }) => app === 'staff')?.entryObjects).toEqual([HR_MOVEMENT_OBJECT]);

  const candidates = '/api/tenant/analytics/organization-candidates?object=HrMovement&asOf=' + today;
  expect(await json(await get(candidates))).toMatchObject({
    items: expect.arrayContaining([
      { id: child.id, name: child.name, parentId: parent.id, enabled: true },
      { id: outside.id, name: outside.name, parentId: tenant, enabled: true },
    ]),
  });
  for (const path of [candidates, MOVEMENT_BASE, MOVEMENT_BASE + '/components/6.28?group=2026-02']) {
    expect((await api.request('GET', path, { ...who, user: denied.id })).status).toBe(403);
  }
  for (const path of ['/hr-dashboard', '/hr-structure', '/hr-movement/reports/monthly']) {
    expect((await get('/api/tenant/analytics' + path)).status).toBe(403);
  }

  type Board = {
    asOf: string;
    hasDataPermission: boolean;
    components: { code: string; value: number | null; groups: MovementGroup[] }[];
  };
  const overview = async (departmentId: string) =>
    json<Board>(await get(MOVEMENT_BASE + '?' + new URLSearchParams({ asOf: today, departmentId })));
  expect((await overview(parent.id)).hasDataPermission).toBe(false);
  await json(
    await api.request('PUT', `/api/tenant/permission/scopes/${reader.id}/TenantBase`, {
      ...asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: parent.id, includeDescendants: true }] },
    }),
  );

  const board = await overview(parent.id);
  expect(board).toMatchObject({ asOf: today, hasDataPermission: true });
  const groups = (code: string, data = board) => data.components.find((item) => item.code === code)!.groups;
  expect(groups('6.25')).toHaveLength(12);
  expect(groups('6.26')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'exit:2026-01', count: 0 }),
      expect.objectContaining({ key: 'exit:2026-02', count: 1 }),
    ]),
  );
  expect(groups('6.28').find(({ key }) => key === '2026-02')).toMatchObject({
    rate: 2,
    opening: 1,
    closing: 0,
    count: 1,
  });
  expect(groups('6.26', await overview(outside.id)).every(({ count }) => count === 0)).toBe(true);
  expect((await overview(internDept.id)).components.find(({ code }) => code === '6.32')).toMatchObject({
    value: 1,
    groups: [{ key: internDept.id, count: 1, ratio: 1 }],
  });

  const detail = async (code: string, group?: string, page = '1') => {
    const query = new URLSearchParams({ asOf: board.asOf, departmentId: parent.id, page, pageSize: '20' });
    if (group !== undefined) query.set('group', group);
    return get(`${MOVEMENT_BASE}/components/${code}?${query}`);
  };
  const row = { id: exited, employeeId: exited, organizationId: child.id };
  expect(await json(await detail('6.26', 'exit:2026-02'))).toMatchObject({ total: 1, items: [row] });
  expect(await json(await detail('6.28', '2026-02'))).toMatchObject({ total: 1, page: 1, pageSize: 20, items: [row] });
  expect(await json(await detail('6.28', '2026-02', '2'))).toMatchObject({ total: 1, page: 2, items: [] });
  expect((await detail('6.28')).status).toBe(400);
  expect((await detail('unknown')).status).toBe(404);

  expect(menuNodes(PAGES.entries, snapshot)[0]?.children?.map(({ key }) => key)).toEqual(['hr-dashboard']);
}, 120_000);
