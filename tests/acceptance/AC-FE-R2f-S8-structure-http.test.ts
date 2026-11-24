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
import { structureWorld, TODAY, type Report } from './AC-HA-13a-support.js';
import { downloadXlsx, expectModesEqual } from './AC-HA-F482-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { formulaCells, valueAt } from './support/xlsx-read.js';

const database = useTestDb();
const object = 'HrStructureReport';
const prefix = 'ZZ_FER2F_';
const historical = '2026-05-01';
const api = (db: Db) => tenantApi(db, { authorize: undefined, clock: () => new Date(`${TODAY}T01:00:00Z`) });
const candidatePath = `/api/tenant/analytics/organization-candidates?object=${object}&asOf=${TODAY}`;

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
  const world = await structureWorld(db, prefix + 'S8');
  const other = await structureWorld(db, prefix + 'S8_OTHER');
  const parent = await world.org(prefix + 'PARENT');
  const child = await world.org(prefix + 'CHILD', parent);
  const outside = await world.org(prefix + 'OUTSIDE');
  const foreign = await other.org(prefix + 'FOREIGN');
  const category = await world.category(prefix + 'CATEGORY');
  const unused = await world.category(prefix + 'UNUSED');
  const sequence = await world.job('sequences', prefix + 'SEQUENCE');
  await world.hire(prefix + 'EMPLOYEE', {
    date: '2026-01-01',
    department: child,
    profile: { birthday: '2001-10-01' },
    fields: { employmentType: category.id, employmentSource: prefix + 'SOURCE' },
  });
  await world.hire(prefix + 'INTERN', {
    date: '2026-06-01',
    department: child,
    fields: { employType: 'intern' },
  });
  await world.hire(prefix + 'OUTSIDE_EMPLOYEE', {
    date: '2026-01-01',
    department: outside,
    fields: { employmentType: unused.id },
  });
  const viewer = await createUser(
    db,
    { email: `zz_fer2f_${uniqueSuffix()}@example.com`, displayName: prefix + 'VIEWER' },
    cmd(),
  );
  await grantView(db, world.tenantId, viewer.id);
  await grantView(db, other.tenantId, viewer.id);
  await bootstrapTenantAdmin(db, { tenantId: world.tenantId, userId: world.who.user }, cmd());
  const client = api(db);
  const scope = await client.request('PUT', `/api/tenant/permission/scopes/${viewer.id}/TenantBase`, {
    ...world.who,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: parent.id, includeDescendants: true }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const get = (path: string, tenant = world.tenantId, user = viewer.id) =>
    client.request('GET', path, { tenant, user });
  return { get, world, other, parent, child, outside, foreign, sequence };
}

let x: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  x = await fixture();
}, 120_000);

async function json<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<T>;
}

it('AC-FE-R2f-07 B53 请求走真实 HTTP，动态维度与含下级切换，素质两种下载取同条件', async () => {
  const position = reportOf('position');
  expect(position, '前端应登记员工任职结构报表').toBeDefined();
  const filters = { ...initialFilters('position', TODAY), departmentId: x.parent.id };
  const read = (changes = {}) => x.get(reportUrl(position!, { ...filters, ...changes }, 1)).then(json<Report>);
  const initial = await read();
  expect(initial).toMatchObject({
    asOf: TODAY,
    employType: 'internal',
    rows: [{ organizationId: x.parent.id }],
    summary: { cells: { total: 1 } },
  });
  const keys = initial.columns.map(({ key }) => key);
  expect(keys).toEqual(
    expect.arrayContaining([
      'employType:internal:ratio',
      `source:${prefix}SOURCE`,
      `category:${prefix}CATEGORY`,
      `sequence:${x.sequence.id}`,
    ]),
  );
  expect(keys).not.toContain(`category:${prefix}UNUSED`);
  expect((await read({ departmentIncludeChildren: 'false' })).summary.cells.total).toBe(0);
  expect((await read({ asOf: historical, employType: 'all' })).summary.cells.total).toBe(1);
  const both = await read({ employType: 'all' });
  expect(both.summary.cells).toMatchObject({ total: 2, 'employType:intern:ratio': 0.5 });
  expect((await x.get(`${position!.endpoint}/export?mode=data`)).status).toBe(404);

  const quality = reportOf('quality')!;
  const applied = { ...filters, asOf: historical, employType: 'all' };
  const result = await json<Report>(await x.get(reportUrl(quality, applied, 1)));
  expect(result.summary.cells).toMatchObject({ total: 1, avgAge: 24 });
  const file = '员工素质结构.xlsx';
  const data = await downloadXlsx(x.get, reportUrl(quality, applied, undefined, true, 'data'), file);
  const formula = await downloadXlsx(x.get, reportUrl(quality, applied, undefined, true, 'formula'), file);
  expectModesEqual(data.book, formula.book);
  expect(formulaCells(formula.book).length).toBeGreaterThan(0);
  expect(valueAt(data.book, 'D5')).toBe(result.summary.cells.total);
});

it('AC-FE-R2f-11 B53 候选可读范围外部门，报表空结果与无范围有别，跨租户重新验权', async () => {
  const tree = (tenant?: string) => x.get(candidatePath, tenant).then(json<{ items: { id: string }[] }>);
  const ids = (await tree()).items.map(({ id }) => id);
  expect(ids).toEqual(expect.arrayContaining([x.parent.id, x.child.id, x.outside.id]));
  expect(ids).not.toContain(x.foreign.id);
  expect((await tree(x.other.tenantId)).items.map(({ id }) => id)).toContain(x.foreign.id);
  expect((await tree(x.other.tenantId)).items.map(({ id }) => id)).not.toContain(x.child.id);
  expect((await x.get(candidatePath, x.other.tenantId, x.world.who.user)).status).toBe(403);

  const path = reportUrl(reportOf('quality')!, {
    ...initialFilters('quality', TODAY),
    departmentId: x.outside.id,
    employmentType: prefix + 'UNUSED',
  });
  const result = await json<Report>(await x.get(path));
  expect(result).toMatchObject({ hasDataPermission: true, rows: [], summary: { cells: { total: 0 } } });
  const emptyScope = await json<Report>(await x.get(path, x.other.tenantId));
  expect(emptyScope).toMatchObject({ hasDataPermission: false, rows: [], summary: { cells: { total: 0 } } });
  expect((await x.get(path, x.other.tenantId, x.world.who.user)).status).toBe(403);
  expect(new URLSearchParams(path.split('?')[1]).has('employmentType'), 'B53 不发 B49 人员类别').toBe(false);
});
