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
import { initialFilters, reportOf, reportUrl } from '../../apps/web/src/hr-reports/model.js';
import { structureWorld } from './AC-HA-13a-support.js';
import { movementWorld, MOVEMENT_TODAY as asOf, type MovementReport } from './AC-HA-13b-support.js';
import { downloadXlsx, expectModesEqual } from './AC-HA-F482-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { valueAt } from './support/xlsx-read.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_';
const object = 'HrMovementReport';

async function grantView(db: Db, tenantId: string, userId: string) {
  await grantMembership(db, { tenantId, userId, expectedRevision: 0 }, cmd());
  await withTenant(db, tenantId, async (tx) => {
    const [profile] = await tx
      .insert(permissionProfiles)
      .values({ tenantId, code: object, name: prefix + object })
      .returning();
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
  const db = database().db;
  const world = await movementWorld(db);
  const other = await structureWorld(db, prefix + 'S9A_OTHER');
  const leaf = await world.org(prefix + 'LEAF', world.A1);
  const foreign = await other.org(prefix + 'FOREIGN');
  await world.hire(prefix + 'LEAF_EMPLOYEE', '2026-03-01', leaf);
  const viewer = await createUser(
    db,
    { email: `zz_fer2f_${uniqueSuffix()}@example.com`, displayName: prefix + 'VIEWER' },
    cmd(),
  );
  await grantView(db, world.tenantId, viewer.id);
  await grantView(db, other.tenantId, viewer.id);
  await bootstrapTenantAdmin(db, { tenantId: world.tenantId, userId: world.who.user }, cmd());
  const client = tenantApi(db, { authorize: undefined, clock: () => new Date(`${asOf}T01:00:00Z`) });
  const scope = await client.request('PUT', `/api/tenant/permission/scopes/${viewer.id}/TenantBase`, {
    ...world.who,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: world.A.id, includeDescendants: true }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const get = (path: string, tenant = world.tenantId, user = viewer.id) =>
    client.request('GET', path, { tenant, user });
  return { get, world, other, leaf, foreign };
}

let x: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  x = await fixture();
}, 180_000);

async function json<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<T>;
}
const table = (report: MovementReport, code: string) => report.tables!.find(({ key }) => key === code)!;

it('AC-FE-R2f-08 B54 年度下钻和月表走真实 HTTP，各机构与各月 XLSX 两种模式使用相同筛选', async () => {
  const flow = reportOf('flow');
  expect(flow, '前端应登记员工流动统计报表').toBeDefined();
  const { world, leaf } = x;
  const filters = { asOf, year: '2026', departmentId: world.A.id };
  async function drill(parentId = '') {
    const result = await x.get(reportUrl(flow!, { ...filters, parentId }, 1)).then(json<MovementReport>);
    expect(result).toMatchObject({ asOf, year: 2026, month: null, hasDataPermission: true });
    return table(result, 'flow');
  }
  expect((await drill()).rows.map(({ key }) => key)).toEqual([world.A.id]);
  expect((await drill(world.A.id)).rows.map(({ key }) => key)).toEqual(
    expect.arrayContaining([world.A.id, world.A1.id]),
  );
  const child = await drill(world.A1.id);
  expect(child.rows).toContainEqual(
    expect.objectContaining({ key: leaf.id, cells: expect.objectContaining({ hires: 1 }) }),
  );
  expect(child.rows.map(({ key }) => key)).not.toContain(world.A.id);
  expect((await drill(world.B.id)).summary.cells).toMatchObject({ yearStart: 0, yearEnd: 0 });
  expect((await x.get(reportUrl(flow!, filters, undefined, true, 'data'))).status).toBe(404);

  for (const code of ['monthly', 'institution'] as const) {
    const report = reportOf(code)!;
    const applied = { ...filters, ...(code === 'institution' ? { month: '1' } : {}) };
    const result = await x.get(reportUrl(report, applied, 1)).then(json<MovementReport>);
    const rows = table(result, code).rows;
    expect(result).toMatchObject({ asOf, year: 2026, month: code === 'institution' ? 1 : null });
    expect(rows[0]).toMatchObject({ key: code === 'institution' ? world.A.id : '2026-01', cells: { exits: 1 } });
    if (code === 'monthly') {
      expect(rows).toHaveLength(12);
      expect(rows[1]).toMatchObject({ key: '2026-02', cells: { exits: 0 } });
      expect(rows[10]).toMatchObject({
        key: '2026-11',
        cells: { opening: null, hires: null, exits: null, closing: null, rate: null },
      });
    }
    const file = `${report.name}.xlsx`;
    const data = await downloadXlsx(x.get, reportUrl(report, applied, undefined, true, 'data'), file);
    const formula = await downloadXlsx(x.get, reportUrl(report, applied, undefined, true, 'formula'), file);
    expectModesEqual(data.book, formula.book);
    expect(valueAt(data.book, code === 'institution' ? 'E4' : 'E3')).toBe(1);
  }
});

it('AC-FE-R2f-11 B54 仅查看权可读本租户候选，范围外为空，换租户重新解析范围', async () => {
  const { world, other, foreign } = x;
  const candidatePath = `/api/tenant/analytics/organization-candidates?object=${object}&asOf=${asOf}`;
  const ids = async (tenant?: string) =>
    (await x.get(candidatePath, tenant).then(json<{ items: { id: string }[] }>)).items.map(({ id }) => id);
  expect(await ids()).toEqual(expect.arrayContaining([world.A.id, world.B.id, x.leaf.id]));
  expect(await ids()).not.toContain(foreign.id);
  expect(await ids(other.tenantId)).toContain(foreign.id);
  expect(await ids(other.tenantId)).not.toContain(world.A.id);
  expect((await x.get(candidatePath, other.tenantId, world.who.user)).status).toBe(403);

  const report = reportOf('institution')!;
  const path = reportUrl(report, {
    ...initialFilters('institution', asOf),
    departmentId: world.B.id,
    departmentLabel: prefix + 'DISPLAY_ONLY',
  });
  expect(new URLSearchParams(path.split('?')[1]).has('departmentLabel'), '部门名称只用于界面显示').toBe(false);
  const filtered = await x.get(path).then(json<MovementReport>);
  expect(filtered.hasDataPermission).toBe(true);
  expect(table(filtered, 'institution')).toMatchObject({ rows: [], summary: { cells: { opening: 0, exits: 0 } } });
  const emptyScope = await x.get(path, other.tenantId).then(json<MovementReport>);
  expect(emptyScope.hasDataPermission).toBe(false);
  expect(table(emptyScope, 'institution').rows).toEqual([]);
  expect((await x.get(path, other.tenantId, world.who.user)).status).toBe(403);
});
