import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
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
it.each([
  ['2026-10-20', '2026-10-21'],
  ['2026-10-17', '2026-10-18'],
])('AC-HA-F417③：退休于 %s 先生效，返聘批准日期 %s 的审计、事件及重放', async (retirementDay, expectedDate) => {
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
  await x.approve(retirement, `${retirementDay}T02:00:00Z`);
  expect(await x.business(retirement.id)).toMatchObject({ status: 'effective', effectiveDate: retirementDay });
  expect((await x.business(target.id)).effectiveDate).toBe('2026-10-18');
  expect(await stamp(), '退休先生效不改仍在审批中的实例').toEqual(before);
  const commandId = randomUUID();
  const approve = () =>
    api.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ...as,
      user: task.assigneeUserId,
      ifMatch: view.revision,
      idempotencyKey: commandId,
      body: {},
    });
  const approved = await approve();
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect((await x.business(target.id)).effectiveDate).toBe(expectedDate);
  expect.soft(await stamp(), '最终批准必须同次保存顺延后的看板日期，保留审批版本与完成时间').toEqual({
    ...before,
    date: expectedDate,
    status: 'approved',
    revision: before.revision + 1,
    completedAt,
  });
  const changed = expectedDate !== before.date;
  const evidence = await dateEvidence();
  expect
    .soft(evidence.events, '日期改变应在批准的同一 revision 产生且仅产生一条刷新事件')
    .toEqual(changed ? [{ revision: before.revision + 1, commandId }] : []);
  expect
    .soft(evidence.audits, '日期改变必须记录精确的 businessDate 前后字段审计')
    .toEqual(
      changed ? [{ before: { businessDate: '2026-10-18' }, after: { businessDate: '2026-10-21' }, commandId }] : [],
    );
  const saved = await stamp();
  const replay = await approve();
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json(), '原命令 ID / revision 重放返回原批准回执').toEqual(await approved.json());
  expect(await stamp(), '重放不增加实例 revision 或改变日期').toEqual(saved);
  expect(await dateEvidence(), '重放不增加日期审计或 outbox').toEqual(evidence);
  const board = processClient(x.db, as, { now: () => new Date(completedAt) });
  const late = changed ? [] : [item!.id];
  await board.expectComponent('lateApprovalByCategory', { all: late }, 'category=entry');
  await board.expectComponent('nonCompliantByWeek', { all: [item!.id], hits: late }, 'category=entry');

  async function dateEvidence() {
    return withTenant(x.db, as.tenant, async (tx) => {
      const events = rowsOf<{ revision: number; commandId: string }>(
        await tx.execute(sql`
        SELECT revision, command_id AS "commandId" FROM approval_outbox
        WHERE tenant_id=${as.tenant} AND object_id=${item!.id}::uuid
          AND event_type='approval.instance.dashboard_date_refreshed' ORDER BY id`),
      );
      const audits = rowsOf<{ before: unknown; after: unknown; commandId: string }>(
        await tx.execute(sql`
        SELECT before, after, command_id AS "commandId" FROM audit_events
        WHERE tenant_id=${as.tenant} AND object_id=${item!.id}
          AND action='approval.instance.dashboard_date_refreshed' ORDER BY id`),
      );
      return { events, audits };
    });
  }

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
