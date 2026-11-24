import './support/exit-gate-enforced.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  processDefaults,
  processDetailTable,
  processDetailUrl,
  processMetrics,
  processOverviewUrl,
  processPoints,
  processTrend,
  type ProcessDetail,
  type ProcessDrill,
  type ProcessOverview,
} from '../../apps/web/src/hr-analytics/process-model.js';
import { approvalWorld, grantFieldAccess, permissionAdmin, type InstanceView, type Person } from './AC-APV-support.js';

const database = useTestDb();
const prefix = 'ZZ_FER2F_S4B_';
const at = (date: string, hour = '01') => `${date}T${hour}:00:00.000Z`;

/**
 * 前端渲染模型直接吃真实接口回执：比率卡的命中项钻取 = 服务端 hits，业务总量钻取 = total；
 * 业务单明细里调用者看不到的审批实例 ID 仍为空（F-415），且计入审批总量。
 * 时间轴：A 业务日期 10-01、10-05 发起（晚提交）；B 业务日期 10-20、10-05 发起（合规）；
 * H 同组织、另一审批人（读者不可披露）；D 10-10 直接调动（不走流程，只计业务总量）。asOf = 10-20。
 */
it('AC-FE-R2f-05 质量与应用：比率卡命中钻取对真实明细，业务单不可见实例 ID 为空', async () => {
  const w = await approvalWorld(database().db, prefix);
  w.setNow(at('2026-09-01'));
  const team = await w.org(prefix + '团队');
  const child = await w.org(prefix + '下级', team);
  const reader = await w.person(prefix + '审批人', team);
  const other = await w.person(prefix + '另一审批人', team);
  await w.publishedProcess({
    nodes: [{ key: 'manager', name: prefix + '经理审批', approver: { type: 'object_field', value: 'direct_manager' } }],
  });

  async function approved(name: string, manager: Person, businessDate: string, submitDay: string) {
    const subject = await w.person(prefix + name, child, { directManagerId: manager.employeeId });
    w.setNow(at(submitDay));
    const business = await w.application(subject.employeeId, { departmentId: team }, { effectiveDate: businessDate });
    const view = await w.submit(business);
    const task = w.pending(view)[0]!;
    expect(task.assigneeUserId).toBe(manager.userId);
    w.setNow(at(submitDay, '05'));
    const done = await w.json<InstanceView>(await w.taskAction(manager.userId, task.id, 'approve', view.revision));
    expect(done.status).toBe('approved');
    return { business: business.id, instance: view.id };
  }
  const late = await approved('晚提交', reader, '2026-10-01', '2026-10-05');
  const onTime = await approved('合规', reader, '2026-10-20', '2026-10-05');
  const hidden = await approved('不可披露', other, '2026-10-20', '2026-10-06');
  const directSubject = await w.person(prefix + '直接调动', child);
  w.setNow(at('2026-10-10'));
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${directSubject.employeeId}`),
  );
  const direct = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${directSubject.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-10', fields: { departmentId: team } },
    }),
    201,
  );
  w.setNow(at('2026-10-20'));

  const admin = await permissionAdmin(w);
  await grantFieldAccess(admin, reader.userId, { view: [] }, MODULE_OBJECTS.hrProcessDashboard);
  await w.json(
    await admin.api.request('PUT', '/api/tenant/permission/scopes/' + reader.userId + '/TenantBase', {
      ...admin.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: team, includeDescendants: true }] },
    }),
  );
  const get = <T>(path: string) => admin.api.request('GET', path, w.as(reader.userId)).then((r) => w.json<T>(r));
  const filters = processDefaults('2026-10-20');
  const board = await get<ProcessOverview>(processOverviewUrl(filters));
  const component = (code: string) => board.components.find((item) => item.code === code)!;
  const read = (item: ProcessOverview['components'][number], drill: ProcessDrill) =>
    get<ProcessDetail>(processDetailUrl(item.code, filters, 1, drill));

  const usage = component('transferApprovalRate');
  const metrics = processMetrics(usage);
  expect(metrics.map(({ label }) => label)).toEqual(['占比', '审批总量', '业务总量']);
  const [, approvals, businesses] = metrics;
  expect([approvals!.value, businesses!.value]).toEqual([3, 4]);
  const approvedRows = await read(usage, approvals!.drill!);
  expect(approvedRows.total, '审批总量钻取 = 服务端 hits').toBe(usage.hits);
  const table = processDetailTable(approvedRows);
  expect(table.columns.map(({ key }) => key)).toEqual(['id', 'instanceId', 'group', 'hit']);
  const byBusiness = new Map(table.rows.map((row) => [row.id, row]));
  expect(byBusiness.get(hidden.business)).toMatchObject({ instanceId: null, hit: '是' });
  expect(byBusiness.get(late.business)).toMatchObject({ instanceId: late.instance, hit: '是' });
  expect(byBusiness.has(direct.id)).toBe(false);
  const allRows = processDetailTable(await read(usage, businesses!.drill!));
  expect(allRows.total, '业务总量钻取 = 服务端 total').toBe(usage.total);
  expect(allRows.rows.find((row) => row.id === direct.id)).toMatchObject({ instanceId: null, hit: '否' });
  const org = processTrend(usage, processPoints(usage)).series[1]!.points[0]!;
  expect(org.drill).toEqual({ group: team, hit: true });
  expect((await read(usage, org.drill)).total).toBe(3);

  const quality = component('nonCompliantByWeek');
  const [, nonCompliant, passed] = processMetrics(quality);
  expect([nonCompliant!.value, passed!.value], '读者只看得到自己审批的两单').toEqual([1, 2]);
  const lateRows = processDetailTable(await read(quality, nonCompliant!.drill!));
  expect(lateRows.rows.map(({ instanceId, hit }) => [instanceId, hit])).toEqual([[late.instance, '是']]);
  expect(lateRows.rows.map(({ instanceId }) => instanceId)).not.toContain(onTime.instance);
  const week = processPoints(quality)[0]!;
  expect(week.category).toBe('2026-10-05');
  expect((await read(quality, week.drill)).total).toBe(2);
}, 120_000);
