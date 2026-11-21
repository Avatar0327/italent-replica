import { bootstrapTenantAdmin, routeManifest } from '@italent/api';
import {
  createUser,
  grantMembership,
  permissionGrants,
  permissionProfileApps,
  permissionProfileObjects,
  permissionProfiles,
  withTenant,
  type Db,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { structureWorld, TODAY } from './AC-HA-13a-support.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  readFrozenRecorded,
  writeFrozenRecorded,
} from './support/route-policy/recorded.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const BASE = '/api/tenant/analytics/organization-candidates';
const ENDPOINT = `GET ${BASE}`;
const recorder = createRecorder();
const OBJECTS = [
  'HrDashboard',
  'HrStructure',
  'HrMovement',
  'HrProcessDashboard',
  'ContractBoard',
  'HrRoster',
  'HrStructureReport',
  'HrMovementReport',
] as const;
type AnalysisObject = (typeof OBJECTS)[number];

async function grantView(db: Db, tenantId: string, userId: string, object: AnalysisObject) {
  await withTenant(db, tenantId, async (tx) => {
    const [profile] = await tx.insert(permissionProfiles).values({ tenantId, code: object, name: object }).returning();
    const profileId = profile!.id;
    await tx.insert(permissionProfileApps).values({ tenantId, profileId, appCode: 'TenantBase' });
    await tx.insert(permissionProfileObjects).values({
      tenantId,
      profileId,
      objectCode: `TenantBase.${object}`,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    });
    await tx.insert(permissionGrants).values({ tenantId, profileId, userId });
  });
}

async function fixture() {
  const db = testDb().db;
  const main = await structureWorld(db, 'f541-main');
  const other = await structureWorld(db, 'f541-other');
  const a = await main.org('ZZ_F541_A');
  const b = await main.org('ZZ_F541_B', a);
  const outside = await main.org('ZZ_F541_OUTSIDE');
  await other.org('ZZ_F541_FOREIGN');
  const date = '2026-04-01';
  await main.hire('合成甲', { date: '2026-03-02', department: a });
  await main.hire('合成乙', { date: '2026-03-02', department: outside });
  const stop = await main.call('PATCH', `/api/tenant/org/organizations/${b.id}`, {
    ifMatch: b.revision,
    body: { enabled: false, effectiveDate: date },
  });
  expect(stop.status, await stop.clone().text()).toBe(200);
  const api = tenantApi(db, { authorize: undefined, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const users = new Map<AnalysisObject, string>();
  for (const object of OBJECTS) {
    const user = await createUser(db, { email: `f541-${uniqueSuffix()}@example.com`, displayName: object }, cmd());
    await grantMembership(db, { tenantId: main.tenantId, userId: user.id, expectedRevision: 0 }, cmd());
    await grantView(db, main.tenantId, user.id, object);
    users.set(object, user.id);
  }
  const hr = users.get('HrStructure')!;
  await grantMembership(db, { tenantId: other.tenantId, userId: hr, expectedRevision: 0 }, cmd());

  await bootstrapTenantAdmin(db, { tenantId: main.tenantId, userId: main.who.user }, cmd());
  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${users.get('HrMovementReport')}/TenantBase`, {
    user: main.who.user,
    tenant: main.tenantId,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: a.id, includeDescendants: true }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  return { api, users, main, other, a, b, outside };
}

describe('F-541 人事分析组织候选 HTTP', () => {
  let x: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    x = await fixture();
  }, 120_000);

  function get(object: string, who: AnalysisObject = 'HrStructure', tenant = x.main.tenantId, asOf?: string) {
    const query = new URLSearchParams({ object });
    if (asOf !== undefined) query.set('asOf', asOf);
    return x.api.request('GET', `${BASE}?${query}`, { user: x.users.get(who), tenant });
  }
  const readNodes = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const expected = (enabled: boolean) => ({
    items: [
      { id: x.main.tenantId, name: x.main.session.tenant.name, parentId: null, enabled: true },
      { id: x.a.id, name: x.a.name, parentId: x.main.tenantId, enabled: true },
      { id: x.b.id, name: x.b.name, parentId: x.a.id, enabled },
      { id: x.outside.id, name: x.outside.name, parentId: x.main.tenantId, enabled: true },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  });
  async function expectTree(response: Response, enabled = false) {
    const body = (await readNodes(response)) as ReturnType<typeof expected>;
    body.items.sort((a, b) => a.id.localeCompare(b.id));
    expect(body).toEqual(expected(enabled));
  }

  it.each(OBJECTS)('AC-HA-F541-01：只授 %s 查看权也能读取全租户行政树，逐节点仅四个字段', async (object) => {
    const response = await get(object, object);
    await expectTree(response.clone());
    recorder.recordFact(ENDPOINT, 'fixedKeys', await observe(response));
  });

  it.each(OBJECTS)('AC-HA-F541-02：只有其他分析对象查看权，查询 %s 返回 403', async (object) => {
    const who = object === 'HrStructure' ? 'HrRoster' : 'HrStructure';
    const response = await get(object, who);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await errorCode(response.clone())).toBe('FORBIDDEN');
    recorder.recordFact(ENDPOINT, 'outcome', await observe(response));
  });

  it('AC-HA-F541-03：组织主数据树 403，仅有 B49 查看权仍可读候选，历史时点停用标识按版本返回', async () => {
    const who = { user: x.users.get('HrStructure'), tenant: x.main.tenantId };
    const master = await x.api.request('GET', '/api/tenant/org/organizations/tree?dimension=admin', who);
    expect(master.status).toBe(403);
    await expectTree(await get('HrStructure'));
    await expectTree(await get('HrStructure', 'HrStructure', x.main.tenantId, '2026-03-31'), true);
  });

  it('AC-HA-F541-04：树隔离租户，切租户后重新查成员与对象查看权', async () => {
    await expectTree(await get('HrStructure'));
    const foreign = await get('HrStructure', 'HrStructure', x.other.tenantId);
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe('FORBIDDEN');
    const nonmember = await get('HrRoster', 'HrRoster', x.other.tenantId);
    expect(nonmember.status).toBe(403);
    expect(await errorCode(nonmember)).toBe('TENANT_NOT_MEMBER');
  });

  it.each(['', 'constructor', 'Organization', 'TenantBase.HrStructure'])(
    'AC-HA-F541-05：非法对象 %j 返回 400',
    async (object) => {
      const response = await get(object);
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await errorCode(response.clone())).toBe('VALIDATION_FAILED');
      recorder.recordFact(ENDPOINT, 'outcome', await observe(response));
    },
  );

  it('AC-HA-F541-05：缺少对象及非法时点返回 400', async () => {
    const missing = await x.api.request('GET', BASE, { user: x.users.get('HrStructure'), tenant: x.main.tenantId });
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('VALIDATION_FAILED');
    const badDate = await get('HrStructure', 'HrStructure', x.main.tenantId, '2026-02-30');
    expect(badDate.status).toBe(400);
    expect(await errorCode(badDate)).toBe('VALIDATION_FAILED');
  });

  it('AC-HA-F541-06：B54 能选范围外组织，实际报表仍按管理范围统计', async () => {
    await expectTree(await get('HrMovementReport', 'HrMovementReport'));
    const who = { user: x.users.get('HrMovementReport'), tenant: x.main.tenantId };
    const report = '/api/tenant/analytics/hr-movement/reports/inflow';
    for (const [org, total] of [
      [x.a, 1],
      [x.outside, 0],
    ] as const) {
      const response = await x.api.request('GET', `${report}?asOf=${TODAY}&departmentId=${org.id}`, who);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { tables: { key: string; summary: { cells: { total: number } } }[] };
      expect(body.tables.find((table) => table.key === 'inflow')?.summary.cells.total, org.name).toBe(total);
    }
  });
});

afterAll(() => {
  const scope = new Set([ENDPOINT]);
  const routes = routeManifest(tenantApi(testDb().db).app).declared;
  const contract = readFrozenContract()!;
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, scope) : frozen;
  expect(checkRecorded({ collected: recorder.facts, frozen: current, scope, routes, contract })).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});
