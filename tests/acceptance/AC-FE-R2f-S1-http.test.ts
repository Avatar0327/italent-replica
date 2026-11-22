import './support/exit-gate-enforced.js';
import { bootstrapTenantAdmin } from '@italent/api';
import { HR_DASHBOARD_OBJECT, type HrDashboardCode } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import {
  detailTable,
  detailUrl,
  indicatorGroups,
  overviewUrl,
  type DashboardDetail,
  type DashboardOverview,
} from '../../apps/web/src/hr-analytics/model.js';
import { dayAt } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { INDICATORS } from './AC-HA-BE12b-support.js';
import { OF_NOW, offerWorld } from './AC-OF-BE14a-support.js';
import { draftRegularization, hire, transition, type PbWorld } from './AC-PB-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_';

async function json<T>(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

it('AC-FE-R2f-02 真实概览的 23 码、三月入职六月离职及转正审批未生效的试用到期', async () => {
  const db = database().db;
  const today = '2026-10-06';
  const w = await downstreamWorld(db, `${prefix}people`, today);
  const person = await w.session.employee(`${prefix}March`);
  await w.session.business(
    person.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-03-10',
      fields: { departmentId: w.from.id, employType: 'internal' },
    },
    person.revision,
  );
  await w.effectiveExit(person.id, '2026-06-20');
  const pb = { db, session: w.session, org: w.from } as unknown as PbWorld;
  const { employee } = await hire(pb, {
    date: '2026-09-01',
    months: 1,
    endDate: '2026-10-26',
    name: `${prefix}Probation`,
  });
  const regularize = await draftRegularization(pb, employee.id, '2026-10-27');
  expect((await transition(pb, regularize, 'submit')).status).toBe(200);
  const api = tenantApi(db, { clock: () => dayAt(today) });
  const get = (path: string) => api.request('GET', path, { user: w.session.user.id, tenant: w.session.tenant.id });
  for (const [date, counts] of [
    ['2026-03-25', [1, 1, 0, 0]],
    ['2026-06-25', [1, 0, 1, 1]],
    ['2026-07-25', [1, 0, 1, 0]],
  ] as const) {
    const overview = await json<DashboardOverview>(await get(overviewUrl(date)));
    const metrics = indicatorGroups(overview.indicators).flatMap(({ items }) => items);
    expect(metrics.map(({ no, code, subject }) => [no, code, subject])).toEqual(INDICATORS);
    expect(overview.asOf).toBe(date);
    const codes = ['entriesThisYear', 'entriesThisMonth', 'leavesThisYear', 'leavesThisMonth'];
    expect(codes.map((code) => metrics.find((metric) => metric.code === code)?.value)).toEqual(counts);
  }
  const board = await json<DashboardOverview>(await get(overviewUrl(today)));
  expect(board.indicators.find(({ code }) => code === 'probationExpiring30')?.value).toBe(1);
  const expiring = await json<DashboardDetail>(await get(detailUrl('probationExpiring30', board.asOf, 1)));
  const inProgress = await json<DashboardDetail>(await get(detailUrl('regularizationInProgress', board.asOf, 1)));
  expect(expiring.items).toEqual([{ id: employee.id, employeeId: employee.id }]);
  expect(inProgress.items).toEqual([{ id: regularize.id, employeeId: employee.id }]);
}, 90_000);

it('AC-FE-R2f-01/02/11 单授 B48 的真实快照、三项 Offer、空范围及跨租户拒绝', async () => {
  const db = database().db;
  const w = await offerWorld(db, `${prefix}offers`);
  const pending = await w.social({ name: `${prefix}pending` });
  const approving = await w.social({ name: `${prefix}approving` });
  const sent = await w.social({ name: `${prefix}sent` });
  await w.force(approving.id, 'approval_status', 'approving');
  await w.force(sent.id, 'status', 'sent');
  await w.force(sent.id, 'sent_at', '2026-10-12T12:00:00+08:00');
  const api = tenantApi(db, { authorize: undefined, clock: () => OF_NOW });
  const asAdmin = { tenant: w.tenant.id, user: w.user.id };
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const world = { db, api, tenant: w.tenant, admin: w.user, asAdmin, adminRecord };
  const reader = await addMember(world, `${prefix}reader`);
  const denied = await addMember(world, `${prefix}denied`);
  const profile = await createProfile(world, `${prefix}dashboard`);
  const permissions = { dataOperations: { create: false, update: false, delete: false }, fields: [], buttons: [] };
  expect((await setObjectPermission(world, profile, permissions, HR_DASHBOARD_OBJECT)).status).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, reader.id, profile.id)).status).toBe(201);
  const who = { tenant: w.tenant.id, user: reader.id };
  const readSnapshot = (user: string) =>
    api.request('GET', '/api/tenant/permission/me/snapshot', { ...who, user }).then(json<ServerSnapshot>);
  const snapshot = await readSnapshot(reader.id);
  expect(snapshot.apps.find(({ app }) => app === 'staff')?.entryObjects).toEqual([HR_DASHBOARD_OBJECT]);
  expect(menuNodes(PAGES.entries, snapshot)[0]?.children?.map(({ key }) => key)).toEqual(['hr-dashboard']);
  expect(menuNodes(PAGES.entries, await readSnapshot(denied.id))).toEqual([]);

  const overviewPath = overviewUrl('2026-10-17');
  const pendingPath = detailUrl('offerPending', '2026-10-17', 1);
  const get = (path: string) => api.request('GET', path, who);
  const noScope = await json<DashboardOverview>(await get(overviewPath));
  expect(noScope.hasDataPermission).toBe(false);
  expect(noScope.indicators.every(({ value }) => value === 0)).toBe(true);
  expect(await json<DashboardDetail>(await get(pendingPath))).toMatchObject({
    total: 0,
    items: [],
    hasDataPermission: false,
  });

  const scope = await api.request('PUT', `/api/tenant/permission/scopes/${reader.id}/TenantBase`, {
    ...asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: w.department.id, includeDescendants: false }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const board = await json<DashboardOverview>(await get(overviewPath));
  expect(board.hasDataPermission).toBe(true);
  const offers: [HrDashboardCode, string[]][] = [
    ['offerPending', [pending.id, approving.id]],
    ['offerSentThisMonth', [sent.id]],
    ['offerApproving', [approving.id]],
  ];
  for (const [code, ids] of offers) {
    expect(board.indicators.find((metric) => metric.code === code)?.value).toBe(ids.length);
    const body = await json<DashboardDetail>(await get(detailUrl(code, board.asOf, 1)));
    expect(body).toMatchObject({ code, subject: 'offer', page: 1, pageSize: 20, total: ids.length });
    const table = detailTable(body);
    expect(table.columns.map(({ label }) => label)).toEqual(['Offer ID', '员工 ID']);
    expect(table.rows.map(({ id }) => id).sort()).toEqual(ids.sort());
    expect(table.rows.every(({ employeeId }) => employeeId === null)).toBe(true);
  }

  for (const path of [overviewPath, pendingPath]) {
    expect((await api.request('GET', path, { ...who, user: denied.id })).status).toBe(403);
  }
  const other = await seedTenantWithMember(db, `${prefix}other`);
  for (const path of [overviewPath, pendingPath])
    expect((await api.request('GET', path, { ...who, tenant: other.tenant.id })).status).toBe(403);
}, 90_000);
