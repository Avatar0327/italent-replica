import { bootstrapTenantAdmin } from '@italent/api';
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
import { beforeAll, expect, it } from 'vitest';
import { cellText, initialFilters, reportOf, reportUrl, tablesOf } from '../../apps/web/src/hr-reports/model.js';
import { MOVEMENT_TODAY as asOf, movementWorld } from './AC-HA-13b-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_S9B_';
const codes = ['inflow', 'outflow', 'establishment'] as const;
type Code = (typeof codes)[number];

type Payload = Extract<Parameters<typeof tablesOf>[1], { tables: unknown }>;

async function fixture(db: Db) {
  const world = await movementWorld(db);
  const parent = await world.org(prefix + 'PARENT');
  const child = await world.org(prefix + 'CHILD', parent);
  const outside = await world.org(prefix + 'OUTSIDE');
  const sequence = await world.sequence(prefix + 'SEQUENCE');
  const hire = (name: string, department: { id: string }) =>
    world.hire(prefix + name, '2026-01-10', department, { sequenceId: sequence.id });
  const leaver = await hire('LEAVER', child);
  await world.leave(leaver.id, '2026-01-31', { type: world.T.vol, reason: world.R.pay });
  await hire('ACTIVE', child);
  const outsider = await hire('HIDDEN', outside);
  await world.leave(outsider.id, '2026-01-31', { type: world.T.inv, reason: world.R.dev });

  const establishment = '/api/tenant/establishment';
  const scheme = await world.call('POST', `${establishment}/schemes`, {
    ifMatch: 0,
    body: {
      name: prefix + 'SCHEME',
      periodType: 'annual',
      startMonth: 1,
      maintenanceMode: 'local',
      subdivision: 'none',
      startDate: '2026-01-01',
    },
  });
  expect(scheme.status, await scheme.clone().text()).toBe(201);
  const { id: schemeId } = (await scheme.json()) as { id: string };
  for (const [organization, localCapacity] of [
    [parent, 5],
    [child, 3],
    [outside, 17],
  ] as const) {
    const response = await world.call('POST', `${establishment}/capacities`, {
      ifMatch: 0,
      body: { orgId: organization.id, schemeId, periodStart: '2026-01-01', localCapacity, strictControl: false },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }

  const { tenantId } = world;
  async function user(name: string) {
    const created = await createUser(
      db,
      { email: `zz_fer2f_${uniqueSuffix()}@example.com`, displayName: prefix + name },
      cmd(),
    );
    await grantMembership(db, { tenantId, userId: created.id, expectedRevision: 0 }, cmd());
    return created.id;
  }
  const viewer = await user('VIEWER');
  const empty = await user('EMPTY');
  const denied = await user('DENIED');
  const object = 'TenantBase.HrMovementReport';
  await withTenant(db, tenantId, async (tx) => {
    const [profile] = await tx
      .insert(permissionProfiles)
      .values({ tenantId, code: object, name: prefix + 'PROFILE' })
      .returning();
    const profileId = profile!.id;
    await tx.insert(permissionProfileApps).values({ tenantId, profileId, appCode: 'TenantBase' });
    await tx.insert(permissionProfileObjects).values({
      tenantId,
      profileId,
      objectCode: object,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    });
    await tx.insert(permissionGrants).values([viewer, empty].map((userId) => ({ tenantId, profileId, userId })));
  });
  await bootstrapTenantAdmin(db, { tenantId, userId: world.who.user }, cmd());
  const client = tenantApi(db, { authorize: undefined, clock: () => new Date(`${asOf}T01:00:00Z`) });
  const scope = await client.request('PUT', `/api/tenant/permission/scopes/${viewer}/TenantBase`, {
    ...world.who,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: parent.id, includeDescendants: true }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const get = (path: string, userId = viewer) => client.request('GET', path, { tenant: tenantId, user: userId });
  return { get, parent, outside, sequence, world, empty, denied };
}

let x: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  x = await fixture(database().db);
}, 180_000);

function pathOf(code: Code, departmentId = x.parent.id) {
  const report = reportOf(code);
  expect(report, '前端应登记流动报表，用其查询地址读取真实回执').toBeDefined();
  return reportUrl(report!, { ...initialFilters(code, asOf), departmentId }, 1);
}

async function read(code: Code, path: string, user?: string) {
  const response = await x.get(path, user);
  expect(response.status, await response.clone().text()).toBe(200);
  const data = (await response.json()) as Payload;
  expect(data).toMatchObject({ report: code, asOf, year: 2026, month: null });
  return { data, tables: tablesOf(code, data) };
}

it('AC-FE-R2f-08 流入和流出按序列、离职类型与原因取数，各表保留自己的合计', async () => {
  const inflow = await read('inflow', pathOf('inflow'));
  expect(inflow.tables).toMatchObject([
    { key: 'inflow', rows: [{ _label: prefix + 'SEQUENCE', total: 2, averageAge: null }], summary: { total: 2 } },
  ]);
  const outflow = await read('outflow', pathOf('outflow'));
  expect(outflow.tables).toMatchObject([
    { key: 'reasons', rows: [{ _label: '主动离职 / 薪酬', count: 1 }], summary: { count: 1 } },
    { key: 'sequences', rows: [{ _label: prefix + 'SEQUENCE', total: 1 }], summary: { total: 1 } },
  ]);
  expect(outflow.tables[1]?.rows[0]).toMatchObject({ [`type:${x.world.T.vol}`]: 1, [`reason:${x.world.R.pay}`]: 1 });
});

it('AC-FE-R2f-08 编制沿用服务端本级合计，含下级执行率按回执显示', async () => {
  const {
    tables: [table],
  } = await read('establishment', pathOf('establishment'));
  expect(table?.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        _label: prefix + 'PARENT',
        localCapacity: 5,
        inclusiveCapacity: 8,
        actual: 1,
        executionRate: 0.125,
      }),
      expect.objectContaining({
        _label: prefix + 'CHILD',
        localCapacity: 3,
        inclusiveCapacity: 3,
        actual: 1,
        executionRate: 0.3333,
      }),
    ]),
  );
  expect(table?.rows).toHaveLength(2);
  expect(table?.summary).toEqual({
    _label: '合计',
    localCapacity: 8,
    inclusiveCapacity: null,
    actual: null,
    pendingIn: null,
    pendingOut: null,
    vacancy: null,
    executionRate: null,
  });
  expect(cellText('executionRate', table?.rows.find(({ _label }) => _label === prefix + 'PARENT')?.executionRate)).toBe(
    '12.5%',
  );
});

it.each(codes)('AC-FE-R2f-08 / 11 %s 区分范围外部门、空范围、无查看权，并拒绝下载', async (code) => {
  const path = pathOf(code);
  const outside = await read(code, pathOf(code, x.outside.id));
  const empty = await read(code, path, x.empty);
  expect(outside.data.hasDataPermission).toBe(true);
  expect(empty.data.hasDataPermission).toBe(false);
  for (const { tables } of [outside, empty]) {
    expect(tables.length).toBe(code === 'outflow' ? 2 : 1);
    for (const table of tables) expect(table.rows).toEqual([]);
  }
  expect((await x.get(path, x.denied)).status).toBe(403);
  expect((await x.get(`${reportOf(code)!.endpoint}/export?mode=data`)).status).toBe(404);
});
