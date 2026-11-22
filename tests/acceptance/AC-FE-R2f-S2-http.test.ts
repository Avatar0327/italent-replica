import { bootstrapTenantAdmin } from '@italent/api';
import { HR_STRUCTURE_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import {
  structureCards,
  structureDetailTable,
  structureDetailUrl,
  structureOrgUrl,
  structureOverviewUrl,
  type StructureDetail,
  type StructureOverview,
} from '../../apps/web/src/hr-analytics/structure-model.js';
import { STRUCTURE_BASE, TODAY, structureWorld } from './AC-HA-13a-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_';

async function json<T>(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

it('AC-FE-R2f-01/03/11 单授 B49 的真实入口、候选独立范围及统计与分组明细', async () => {
  const db = database().db;
  const w = await structureWorld(db, `${prefix}S2`);
  const parent = await w.org(`${prefix}parent`, undefined, '机构');
  const child = await w.org(`${prefix}child`, parent, '机构');
  const outside = await w.org(`${prefix}outside`);
  const other = await structureWorld(db, `${prefix}foreign`);
  const foreign = await other.org(`${prefix}foreign_node`);
  const categoryName = `${prefix}类别甲`;
  const category = await w.category(categoryName);
  const {
    items: [form],
  } = await json<{ items: { code: string; name: string }[] }>(await w.session.request('GET', '/employment-forms'));
  expect(form!.code).not.toBe(form!.name);
  const inside = await w.hire(`${prefix}inside`, {
    date: '2026-03-12',
    department: child,
    profile: { gender: '女', birthday: '1990-10-01', educationLevel: '本科' },
    fields: { employmentForm: form!.code, employmentType: category.id },
  });
  await w.hire(`${prefix}outside_employee`, { date: '2026-03-12', department: outside });

  const api = tenantApi(db, { authorize: undefined, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: w.tenantId, userId: w.who.user }, cmd());
  const world = { db, api, tenant: w.session.tenant, admin: w.session.user, asAdmin: w.who, adminRecord };
  const reader = await addMember(world, `${prefix}reader`);
  const denied = await addMember(world, `${prefix}denied`);
  const profile = await createProfile(world, `${prefix}structure`);
  const permissions = { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [] };
  expect((await setObjectPermission(world, profile, permissions, HR_STRUCTURE_OBJECT)).status).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, reader.id, profile.id)).status).toBe(201);

  const who = { tenant: w.tenantId, user: reader.id };
  const get = (path: string) => api.request('GET', path, who);
  const snapshot = await json<ServerSnapshot>(await get('/api/tenant/permission/me/snapshot'));
  const entryObjects = snapshot.apps.find(({ app }) => app === 'staff')?.entryObjects;
  expect(entryObjects).toEqual([HR_STRUCTURE_OBJECT]);

  const candidatesPath = structureOrgUrl(TODAY);
  const candidates = async () =>
    json<{ items: { id: string; name: string; parentId: string | null; enabled: boolean }[] }>(
      await get(candidatesPath),
    );
  expect(await candidates()).toEqual({
    items: expect.arrayContaining([
      { id: child.id, name: child.name, parentId: parent.id, enabled: true },
      { id: outside.id, name: outside.name, parentId: w.tenantId, enabled: true },
    ]),
  });
  expect((await candidates()).items.map(({ id }) => id)).not.toContain(foreign.id);
  expect((await api.request('GET', candidatesPath, { ...who, tenant: other.tenantId })).status).toBe(403);
  expect((await api.request('GET', candidatesPath, { ...who, user: denied.id })).status).toBe(403);
  for (const path of [
    '/api/tenant/analytics/hr-dashboard',
    '/api/tenant/job/sequences',
    '/api/tenant/employment/employment-forms',
    '/api/tenant/employment/employment-types/options',
  ])
    expect((await get(path)).status, path).toBe(403);

  async function overview(filters: Record<string, string> = {}) {
    return json<StructureOverview>(await get(structureOverviewUrl({ asOf: TODAY, ...filters })));
  }
  expect(await overview()).toMatchObject({ hasDataPermission: false });
  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${reader.id}/TenantBase`, {
    ...w.who,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: parent.id, includeDescendants: true }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);

  const filters = {
    asOf: TODAY,
    institutionId: parent.id,
    departmentId: parent.id,
    employmentForm: form!.code,
    employmentType: categoryName,
  };
  const board = await overview(filters);
  expect(board).toMatchObject({ asOf: TODAY, hasDataPermission: true });
  expect(board.components[0]).toMatchObject({ code: '6.01', value: 1 });
  expect(board.components[1]).toMatchObject({ code: '6.02', value: 36, count: 1 });
  expect(board.components.slice(8, 10)).toMatchObject([
    { code: '6.09', kind: 'unavailable', value: null, groups: null },
    { code: '6.10', kind: 'unavailable', value: null, groups: null },
  ]);
  for (const zero of [
    { ...filters, institutionIncludeChildren: 'false' },
    { ...filters, departmentIncludeChildren: 'false' },
    { ...filters, employmentType: category.id },
    { ...filters, employmentForm: form!.name },
    { departmentId: outside.id },
  ]) {
    const empty = await overview(zero);
    expect(empty.hasDataPermission).toBe(true);
    expect(empty.components[0]?.value, JSON.stringify(zero)).toBe(0);
  }

  const detail = await json<StructureDetail>(await get(structureDetailUrl('6.14', filters, 1, '女')));
  const cards = structureCards(board);
  expect(cards.find(({ code }) => code === '6.14')?.points.find(({ key }) => key === '女')?.value).toBe(detail.total);
  const average = await json<StructureDetail>(await get(structureDetailUrl('6.02', filters, 1)));
  expect(cards.find(({ code }) => code === '6.02')?.wholeCount).toBe(average.total);
  expect(detail).toMatchObject({
    code: '6.14',
    total: 1,
    page: 1,
    pageSize: 20,
    hasDataPermission: true,
    items: [{ id: inside.id, employeeId: inside.id, organizationId: child.id }],
  });
  expect(structureDetailTable(detail).columns.map(({ label }) => label)).toEqual(['员工 ID', '部门 ID']);
  expect((await api.request('GET', structureOverviewUrl(filters), { ...who, user: denied.id })).status).toBe(403);
  for (const code of ['6.09', '6.10']) expect((await get(`${STRUCTURE_BASE}/components/${code}`)).status).toBe(404);

  expect(menuNodes(PAGES.entries, snapshot)[0]?.children?.map(({ key }) => key)).toEqual(['hr-dashboard']);
}, 120_000);
