import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { approvalWorld, type InstanceView } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { retirementWorld } from './AC-RT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
async function dateOf(db: Db, tenant: string, id: string) {
  return withTenant(db, tenant, async (tx) =>
    rowsOf<{ date: string }>(
      await tx.execute(sql`
    SELECT business_date::text AS date FROM approval_instances
    WHERE tenant_id=${tenant} AND business_id=${id}::uuid AND status='approved'`),
    ),
  );
}

it.each([
  ['transfer', 'scheduler'],
  ['leave', 'scheduler'],
  ['retirement', 'scheduler'],
  ['leave', 'activate'],
  ['retirement', 'activate'],
] as const)('AC-HA-F417③：已批准 %s 经 %s 迟到执行后刷新日期，重复调度不重复写投影', async (kind, trigger) => {
  const w = await approvalWorld(database().db, `f417-scheduled-${kind}-${trigger}`);
  await installExitSeeds(w.db, w.tenant.id);
  const department = await w.org('合成自动顺延部门');
  const manager = await w.person('合成审批人', department);
  const person = await w.person('合成顺延人员', department, { directManagerId: manager.employeeId });
  await w.publishedProcess({
    approvalType: kind,
    conditions: {
      items: [
        {
          no: 1,
          field: 'processCode',
          operator: 'eq',
          value: { transfer: 'TransferProcessNew', leave: 'DimissionProcessNew', retirement: 'RetireProcess' }[kind],
        },
      ],
    },
    nodes: [{ key: 'manager', approver: { type: 'object_field', value: 'direct_manager' } }],
  });
  const current = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${person.employeeId}`),
  );
  const business = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${person.employeeId}/businesses`, {
      ifMatch: current.revision,
      body: {
        kind,
        mode: 'application',
        fields: {},
        ...(kind === 'transfer'
          ? { effectiveDate: '2026-10-15' }
          : { lastWorkDate: '2026-10-15', ...(kind === 'leave' ? { exit: { exitTypeCode: 'voluntary' } } : {}) }),
      },
    }),
    201,
  );
  const instance = await w.submit(business);
  await w.json(await w.taskAction(manager.userId, w.pending(instance)[0]!.id, 'approve', instance.revision));
  expect(await dateOf(w.db, w.tenant.id, business.id)).toEqual([{ date: '2026-10-15' }]);
  const run = () =>
    runEmploymentActivations(w.db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date('2026-10-20T01:00:00Z') });
  if (trigger === 'scheduler') expect((await run()).runs[0]).toMatchObject({ activated: [business.id], failed: [] });
  else {
    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/businesses/${business.id}`),
    );
    const outcome = await runEmploymentTransition(
      w.db,
      {
        tenantId: w.tenant.id,
        userId: w.hr.id,
        timezone: w.tenant.timezone,
        now: new Date('2026-10-20T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: current.revision,
      },
      { id: business.id, action: 'activate' },
    );
    expect(outcome.status).toBe(200);
  }
  expect(await dateOf(w.db, w.tenant.id, business.id)).toEqual([
    { date: kind === 'transfer' ? '2026-10-20' : '2026-10-19' },
  ]);
  const auditCount = () =>
    withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`
      SELECT count(*)::int AS n FROM approval_outbox WHERE tenant_id=${w.tenant.id}
      AND object_id=${instance.id}::uuid AND event_type='approval.instance.dashboard_date_refreshed'`),
      ),
    );
  expect(await auditCount()).toEqual([{ n: 1 }]);
  await run();
  expect(await auditCount()).toEqual([{ n: 1 }]);
});

it('AC-HA-F417③：退休联动顺延已批准返聘，刷新同一返聘实例日期', async () => {
  const x = await retirementWorld(database().db, 'f417-rehire-date');
  const retirement = await x.submittedRetire('2026-10-15');
  const employee = await x.session.getEmployee(x.employee.id);
  const created = await x.session.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: withLoginEmail(employee.id, {
      kind: 'retire_rehire',
      mode: 'application',
      effectiveDate: '2026-10-18',
      fields: { employType: 'internal' },
    }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const target = (await created.json()) as { id: string; revision: number };
  expect(
    (
      await x.session.request('POST', `/businesses/${target.id}/submit`, {
        ifMatch: target.revision,
        body: {},
      })
    ).status,
  ).toBe(200);
  const api = tenantApi(x.db, { clock: () => new Date('2026-10-06T02:00:00Z') });
  const as = { tenant: x.session.tenant.id, user: x.session.user.id };
  const list = await api.request('GET', `/api/tenant/approval/instances?role=initiated&businessId=${target.id}`, as);
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
  expect(await dateOf(x.db, as.tenant, target.id)).toEqual([{ date: '2026-10-18' }]);
  await x.approve(retirement, '2026-10-20T02:00:00Z');
  expect((await x.business(target.id)).effectiveDate).toBe('2026-10-21');
  expect(await dateOf(x.db, as.tenant, target.id)).toEqual([{ date: '2026-10-21' }]);
});
