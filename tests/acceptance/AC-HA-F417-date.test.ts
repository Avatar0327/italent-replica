import './support/exit-gate-enforced.js';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';
import { approvalWorld, type InstanceView } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { hire, pbWorld, regularizeOk, rescheduleRegularization, transition } from './AC-PB-support.js';
import { tenantApi } from './support/tenant-api.js';
import { processClient } from './AC-HA-13c-support.js';

const database = useTestDb();
it('F-417③：审批通过后修改 Offer 入职日期，同事务刷新实例 business_date 和看板晚审批统计', async () => {
  const w = await offerApprovalWorld(database().db, 'f417-date');
  w.setNow('2026-10-01T01:00:00.000Z');
  const offer = await w.offer(w.applicant);
  await w.json(await w.submitRaw(offer));
  w.setNow('2026-10-10T01:00:00.000Z');
  await w.decide(await w.instance(offer.id), w.head, 'approve');
  const approved = await w.get(offer.id);
  const path = `/api/tenant/offers/${offer.id}`;
  const body = { plannedEntryDate: '2026-10-05' };
  const request = () => w.request(w.applicant.userId, 'PUT', path, { ifMatch: approved.revision, body });
  const saved = await w.json<OfferView>(await request());
  expect(saved).toMatchObject({ id: offer.id, approvalStatus: 'approved', plannedEntryDate: '2026-10-05' });
  const dates = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ date: string }>(
      await tx.execute(sql`
    SELECT business_date::text AS date FROM approval_instances
    WHERE tenant_id=${w.tenant.id} AND business_id=${offer.id}::uuid AND status='approved'`),
    ),
  );
  expect(dates, '已通过实例的业务日期必须随改单刷新').toEqual([{ date: '2026-10-05' }]);
  const board = processClient(
    w.db,
    { tenant: w.tenant.id, user: w.hr.id },
    { now: () => new Date('2026-10-20T01:00:00Z') },
  );
  const instance = await w.instance(offer.id);
  await board.expectComponent('lateApprovalByCategory', { all: [instance.id] });
  expect((await request()).status).toBe(409);
  const latest = await w.get(offer.id);
  await w.json(
    await w.request(w.applicant.userId, 'PUT', path, {
      ifMatch: latest.revision,
      body: { plannedEntryDate: '2026-11-01' },
    }),
  );
  await board.expectComponent('lateApprovalByCategory', { all: [] });
});

async function stamp(db: Db, tenant: string, business: string) {
  return withTenant(db, tenant, async (tx) =>
    rowsOf<{ date: string }>(
      await tx.execute(sql`
    SELECT business_date::text AS date FROM approval_instances
    WHERE tenant_id=${tenant} AND business_id=${business}::uuid AND status='approved'`),
    ),
  );
}

it('F-417③：已批准离职改期和已生效离职重定位均刷新最后工作日', async () => {
  const w = await approvalWorld(database().db, 'f417-exit-date');
  await installExitSeeds(w.db, w.tenant.id);
  const org = await w.org('合成离职部门');
  const manager = await w.person('合成负责人', org);
  const person = await w.person('合成离职人员', org, { directManagerId: manager.employeeId });
  await w.publishedProcess({
    approvalType: 'leave',
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] },
    nodes: [{ key: 'manager', approver: { type: 'object_field', value: 'direct_manager' } }],
  });
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${person.employeeId}`),
  );
  const business = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${person.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: '2026-10-20',
        fields: {},
        exit: { exitTypeCode: 'voluntary' },
      },
    }),
    201,
  );
  const view = await w.submit(business);
  await w.json(await w.taskAction(manager.userId, w.pending(view)[0]!.id, 'approve', view.revision));
  async function redate(day: string) {
    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/businesses/${business.id}`),
    );
    return w.json<{ status: string }>(
      await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/exits/${business.id}`, {
        ifMatch: current.revision,
        body: { lastWorkDate: day },
      }),
    );
  }
  expect((await redate('2026-10-25')).status).toBe('approved');
  expect(await stamp(w.db, w.tenant.id, business.id), '批准后离职改期刷新最后工作日').toEqual([{ date: '2026-10-25' }]);
  w.setNow('2026-10-30T01:00:00Z');
  expect((await redate('2026-10-28')).status).toBe('effective');
  expect(await stamp(w.db, w.tenant.id, business.id)).toEqual([{ date: '2026-10-28' }]);
  await redate('2026-10-27');
  expect(await stamp(w.db, w.tenant.id, business.id), '已生效离职重定位刷新最后工作日').toEqual([
    { date: '2026-10-27' },
  ]);
});

it('F-417③：转正批准后改期、落地后再改期均刷新日期', async () => {
  const w = await pbWorld(database().db, 'f417-regular-date', { approval: true });
  const { employee } = await hire(w, { months: 3 });
  const receipt = await regularizeOk(w, { mode: 'application', effectiveDate: '2026-12-01' }, [employee.id]);
  const business = receipt.items[0]!.businessId!;
  expect(business).toBeTruthy();
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { tenant: w.session.tenant.id, user: w.session.user.id };
  const list = await api.request('GET', `/api/tenant/approval/instances?role=initiated&businessId=${business}`, as);
  expect(list.status).toBe(200);
  const [item] = ((await list.json()) as { items: { id: string }[] }).items;
  const view = (await (
    await api.request('GET', `/api/tenant/approval/instances/${item!.id}`, as)
  ).json()) as InstanceView;
  const task = view.tasks.find((t) => t.status === 'pending')!;
  const approved = await api.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
    ...as,
    user: task.assigneeUserId,
    ifMatch: view.revision,
    body: {},
  });
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect((await rescheduleRegularization(w, business, '2026-11-20')).status).toBe(200);
  expect(await stamp(w.db, as.tenant, business), '批准后转正改期刷新日期').toEqual([{ date: '2026-11-20' }]);
  w.session.setNow('2026-11-20T01:00:00Z');
  expect((await transition(w, { id: business }, 'activate', '2026-11-20T01:00:00Z')).status).toBe(200);
  const response = await rescheduleRegularization(w, business, '2026-11-21');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await stamp(w.db, as.tenant, business), '落地后转正改期刷新日期').toEqual([{ date: '2026-11-21' }]);
});
