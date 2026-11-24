import './support/exit-gate-enforced.js';
import { HR_PROCESS_DASHBOARD_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { approvalWorld, grantFieldAccess, permissionAdmin } from './AC-APV-support.js';
import { PROCESS_BASE, type ProcessOverview } from './AC-HA-13c-support.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_S4A_';

it('AC-FE-R2f-05/11 实际 B51 单对象入口、组织范围与审批披露、过滤与在途分页', async () => {
  const w = await approvalWorld(database().db, prefix);
  const team = await w.org(prefix + '团队');
  const child = await w.org(prefix + '下级', team);
  const outside = await w.org(prefix + '范围外');
  const reader = await w.person(prefix + '审批人', team);
  const other = await w.person(prefix + '另一审批人', team);
  const site = await w.org(prefix + '调入部门');
  await w.publishedProcess({
    nodes: [{ key: 'manager', name: prefix + '经理审批', approver: { type: 'object_field', value: 'direct_manager' } }],
  });

  async function submit(name: string, dept: string, manager: string, day: string) {
    const employee = await w.person(prefix + name, dept, { directManagerId: manager });
    w.setNow(day + 'T01:00:00Z');
    return w.submit(await w.application(employee.employeeId, { departmentId: site }, { effectiveDate: '2026-12-01' }));
  }
  const first = await submit('窗口第一天', team, reader.employeeId, '2026-10-02');
  const last = await submit('窗口最后一天', team, reader.employeeId, '2026-10-31');
  const hidden = await submit('同组织不可披露', team, other.employeeId, '2026-10-31');
  await submit('下级', child, reader.employeeId, '2026-10-31');
  await submit('窗口前', team, reader.employeeId, '2026-10-01');
  w.setNow('2026-10-30T17:00:00Z'); // 租户 10 月 31 日，窗口按租户日历闭区间取数。

  const admin = await permissionAdmin(w);
  await grantFieldAccess(admin, reader.userId, { view: [] }, MODULE_OBJECTS.hrProcessDashboard);
  const get = (path: string, user = reader.userId) => admin.api.request('GET', path, w.as(user));
  const snapshot = await w.json<ServerSnapshot>(await get('/api/tenant/permission/me/snapshot'));
  // 员工绑定自带员工档案入口，分析对象仍仅授 B51。
  expect(snapshot.apps.find(({ app }) => app === 'staff')?.entryObjects).toEqual([
    MODULE_OBJECTS.employee.code,
    HR_PROCESS_DASHBOARD_OBJECT,
  ]);

  const picked = new URLSearchParams({ category: 'transfer', departmentId: team });
  const overview = (query = picked) => get(PROCESS_BASE + '?' + query).then((r) => w.json<ProcessOverview>(r));
  const candidates = '/api/tenant/analytics/organization-candidates?object=HrProcessDashboard';
  expect(await w.json(await get(candidates))).toMatchObject({
    items: expect.arrayContaining([
      { id: child, parentId: team, enabled: true, name: prefix + '下级' },
      { id: outside, parentId: w.tenant.id, enabled: true, name: prefix + '范围外' },
    ]),
  });
  for (const path of [candidates, PROCESS_BASE, PROCESS_BASE + '/components/inFlightList']) {
    expect((await get(path, other.userId)).status).toBe(403);
  }
  expect((await overview()).hasDataPermission).toBe(false);
  await w.json(
    await admin.api.request('PUT', '/api/tenant/permission/scopes/' + reader.userId + '/TenantBase', {
      ...admin.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: team, includeDescendants: true }] },
    }),
  );

  const board = await overview();
  expect(board).toMatchObject({ asOf: '2026-10-31', from: '2026-10-02', to: '2026-10-31', hasDataPermission: true });
  expect(board.components.find(({ code }) => code === 'inFlightByApprover')).toMatchObject({
    total: 2,
    groups: [{ key: reader.userId, series: 'transfer', count: 2 }],
  });
  const detail = (code: string, page: number, filter: Record<string, string> = {}) => {
    const { asOf, from, to } = board;
    const query = new URLSearchParams({
      ...Object.fromEntries(picked),
      asOf,
      from,
      to,
      page: String(page),
      pageSize: '1',
      ...filter,
    });
    return get(PROCESS_BASE + '/components/' + code + '?' + query).then((r) =>
      w.json<{
        total: number;
        items: { id: string; instanceId: string | null }[];
        page: number;
        pageSize: number;
      }>(r),
    );
  };
  const firstPage = await detail('inFlightList', 1);
  const secondPage = await detail('inFlightList', 2);
  expect(firstPage).toMatchObject({ total: 2, page: 1, pageSize: 1, items: [{ departmentId: team }] });
  expect(secondPage).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ departmentId: team }] });
  const shown = [...firstPage.items, ...secondPage.items].map(({ instanceId }) => instanceId).sort();
  expect(shown).toEqual([first.id, last.id].sort());
  expect(shown).not.toContain(hidden.id);
  expect(await detail('inFlightByApprover', 1, { group: reader.userId, series: 'transfer' })).toMatchObject({
    total: 2,
  });
  expect(await detail('inFlightByApprover', 1, { group: reader.userId, series: 'offer' })).toMatchObject({ total: 0 });
  expect(await detail('inFlightCount', 1, { hit: 'false' })).toMatchObject({ total: 0 });
  const empty = await overview(new URLSearchParams({ departmentId: outside }));
  expect(empty.hasDataPermission).toBe(true);
  expect(empty.components.find(({ code }) => code === 'inFlightList')?.total).toBe(0);

  const foreign = await approvalWorld(database().db, prefix + 'foreign');
  const foreignRead = await admin.api.request('GET', candidates, { user: reader.userId, tenant: foreign.tenant.id });
  expect(foreignRead.status).toBe(403);
  expect(
    menuNodes(PAGES.entries, snapshot)
      .find(({ key }) => key === 'hr-analytics')
      ?.children?.map(({ key }) => key),
    'B51 单对象快照应注册人事看板入口',
  ).toEqual(['hr-dashboard']);
}, 120_000);
