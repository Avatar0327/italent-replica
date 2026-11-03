import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type { InstanceView } from './AC-APV-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { processClient } from './AC-HA-13c-support.js';
import { retirementWorld } from './AC-RT-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
it('AC-HA-F417③：退休先生效、在审返聘后批准，最终批准采用顺延后的日期', async () => {
  const x = await retirementWorld(database().db, 'f417-approved-rehire-date');
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
  const completedAt = '2026-10-20T03:00:00.000Z';
  const api = tenantApi(x.db, { clock: () => new Date(completedAt) });
  const as = { tenant: x.session.tenant.id, user: x.session.user.id };
  const list = await api.request('GET', `/api/tenant/approval/instances?role=initiated&businessId=${target.id}`, as);
  const [item] = ((await list.json()) as { items: { id: string }[] }).items;
  const view = (await (
    await api.request('GET', `/api/tenant/approval/instances/${item!.id}`, as)
  ).json()) as InstanceView;
  const task = view.tasks.find((t) => t.status === 'pending')!;
  const before = await stamp();
  expect(before).toMatchObject({ date: '2026-10-18', status: 'running', completedAt: null });
  expect((await x.business(target.id)).effectiveDate).toBe('2026-10-18');
  await x.approve(retirement, '2026-10-20T02:00:00Z');
  expect(await x.business(retirement.id)).toMatchObject({ status: 'effective', effectiveDate: '2026-10-20' });
  expect((await x.business(target.id)).effectiveDate).toBe('2026-10-18');
  expect(await stamp(), '退休先生效不改仍在审批中的实例').toEqual(before);
  const approved = await api.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
    ...as,
    user: task.assigneeUserId,
    ifMatch: view.revision,
    body: {},
  });
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect((await x.business(target.id)).effectiveDate).toBe('2026-10-21');
  expect.soft(await stamp(), '最终批准必须同次保存顺延后的看板日期，保留审批版本与完成时间').toEqual({
    ...before,
    date: '2026-10-21',
    status: 'approved',
    revision: before.revision + 1,
    completedAt,
  });
  const board = processClient(x.db, as, { now: () => new Date(completedAt) });
  await board.expectComponent('lateApprovalByCategory', { all: [] }, 'category=entry');
  await board.expectComponent('nonCompliantByWeek', { all: [item!.id], hits: [] }, 'category=entry');

  async function stamp() {
    return withTenant(x.db, as.tenant, async (tx) => {
      const [row] = rowsOf<{
        date: string;
        status: string;
        revision: number;
        businessVersion: string;
        completedAt: string | null;
      }>(
        await tx.execute(sql`
        SELECT business_date::text AS date, status, revision, business_version AS "businessVersion",
          to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt"
        FROM approval_instances WHERE tenant_id=${as.tenant} AND id=${item!.id}::uuid`),
      );
      return row!;
    });
  }
});
