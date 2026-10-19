/**
 * R2-T03 B4 第 2 轮返工：第 1 轮审查（Sol high）5 项 P2 的回归，经真实 HTTP。
 * P2-1 已删除的被摘下调动不得挂回；P2-2 撤销已生效离职同步前驱人员履历；P2-3 通用 DELETE 撤销同键重放；
 * P2-4 挂回调动后“员工已离职”失败待办收敛；P2-5 超编确认与审计带 capacityId / peak / limit。
 * 撤销后恢复时间轴与关联状态只经一个恢复入口（exit-restore.ts），approved / effective、DELETE / POST cancel 共用。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, upsertSystemSetting, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { syncEmploymentHistory } from '../../apps/api/src/modules/personnel/employment-sync.js';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => cancelWorld(database().db, label, TODAY);

describe('P2-1 已删除的被摘下调动保持已删除，撤销离职不再挂回它', () => {
  it('先删 T 再撤销离职 → 200、T 仍 deleted、时间轴只有 hire、清单不报 T 已挂回', async () => {
    const x = await world('r2-deleted-detached');
    const transfer = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    const removed = await x.session.request('DELETE', `/businesses/${transfer.id}`, {
      ifMatch: (await x.business(transfer.id)).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    x.setNow('2026-10-22T01:00:00Z');

    const result = await x.cancelled(leave.id);

    expect(await x.stateOfBusiness(transfer.id)).toBe('deleted');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect(result.downstream.additional.find((entry) => entry.kind === 'future_transfer_detached')).toBeUndefined();
  });
});

describe('P2-2 撤销已生效离职同步前驱人员履历', () => {
  it('开启履历同步：离职生效后履历封口，撤销后时间轴与履历 end_date 同时开放', async () => {
    const x = await world('r2-personnel-history');
    for (const key of ['EntrySyncJobHistory', 'DismissSyncJobHistory']) {
      await upsertSystemSetting(
        x.db,
        { key, value: false, description: key, overridable: true, expectedVersion: 0 },
        { actorUserId: null, commandId: randomUUID() },
      );
      await withTenant(x.db, x.session.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO tenant_setting_overrides (tenant_id,key,value,active,revision,updated_by)
          VALUES(${x.session.tenant.id},${key},'true'::jsonb,true,1,${x.session.user.id})`),
      );
    }
    const [hire] = await x.sqlRows<{ id: string }>(sql`SELECT record_id::text AS id FROM employment_timeline
      WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid ORDER BY start_date LIMIT 1`);
    await withTenant(x.db, x.session.tenant.id, (tx) =>
      syncEmploymentHistory(
        tx,
        {
          tenantId: x.session.tenant.id,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: new Date(`${TODAY}T01:00:00Z`),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        x.employee.id,
        hire!.id,
        'hire',
        '2026-09-01',
      ),
    );
    const history = () =>
      x.sqlRows<{ end_date: string | null }>(sql`SELECT end_date::text FROM personnel_job_history
        WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid AND NOT deleted`);
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    expect(await history()).toMatchObject([{ end_date: '2026-10-05' }]);

    await x.cancelled(leave.id);

    expect((await x.timeline()).map((row) => row.valid)).toEqual(['[2026-09-01,)']);
    expect(await history()).toMatchObject([{ end_date: null }]);
  });
});

describe('P2-3 通用 DELETE 撤销的同键重放', () => {
  it('首次 200；同键同内容重放返回首次回执且只有一条撤销记录；同键异内容 409；新键对已作废单是清理', async () => {
    const x = await world('r2-delete-replay');
    const leave = await x.directLeave('2026-10-20');
    const send = (key: string, reason: string, ifMatch = leave.revision) =>
      x.session.request('DELETE', `/businesses/${leave.id}`, { ifMatch, body: { reason }, idempotencyKey: key });

    const first = await send('r2-delete-replay', '误录入');
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();

    const replay = await send('r2-delete-replay', '误录入');
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    const count = await x.sqlRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM exit_cancellations
      WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid`);
    expect(count[0]!.n).toBe(1);

    const conflict = await send('r2-delete-replay', '换了原因');
    expect(await x.reason(conflict)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

    const cleaned = await send('r2-delete-replay-new', '清理', (await x.business(leave.id)).revision);
    expect(cleaned.status, await cleaned.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(leave.id)).toBe('deleted');
    expect((await x.cancellationOf(leave.id))!.revision).toBe(1);
  });
});

describe('P2-4 挂回调动后“员工已离职”失败待办收敛', () => {
  it('T 到期调度记失败 → 撤销离职后待办消失（历史尝试保留）；未到期的 T 对照仍正常待执行', async () => {
    const x = await world('r2-todo');
    const transfer = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    await x.runScheduler('2026-10-21T01:00:00Z');
    await x.runScheduler('2026-10-25T01:00:00Z');
    expect((await x.todos()).map((todo) => todo.id)).toContain(transfer.id);
    const attempts = (await x.attempts(transfer.id)).length;
    x.setNow('2026-10-26T01:00:00Z');

    await x.cancelled(leave.id);

    expect((await x.todos()).map((todo) => todo.id)).not.toContain(transfer.id);
    expect((await x.attempts(transfer.id)).length).toBe(attempts);
    expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
  });

  it('对照：撤销时 T 尚未到期 → 无待办，T 仍在待执行队列（不被标为已完成）', async () => {
    const x = await world('r2-todo-future');
    const transfer = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-20');
    await x.runScheduler('2026-10-21T01:00:00Z');
    x.setNow('2026-10-22T01:00:00Z');

    await x.cancelled(leave.id);

    expect((await x.todos()).map((todo) => todo.id)).not.toContain(transfer.id);
    expect(await x.attempts(transfer.id)).not.toContainEqual(expect.objectContaining({ outcome: 'effective' }));
    expect(await x.runScheduler('2026-10-25T01:00:00Z')).not.toMatchObject({ failed: [transfer.id] });
  });
});

describe('P2-5 超编确认明细', () => {
  it('409 明细与确认后的审计都带 capacityId / peak = 2 / limit = 1', async () => {
    const x = await world('r2-confirmation-detail');
    const newcomer = await x.newcomer('调入者');
    const leave = await x.directLeave('2026-10-20');
    expect((await x.transferInto(newcomer.id, x.from.id, '2026-10-10')).status).toBe(201);

    const response = await x.cancel(leave.id);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details: { warnings: Record<string, unknown>[] } } };
    expect(body.error.details.warnings[0]).toMatchObject({
      reason: 'ESTABLISHMENT_EXCEEDED',
      departmentId: x.from.id,
      capacityId: expect.any(String),
      peak: 2,
      limit: 1,
    });

    expect((await x.cancel(leave.id, { reason: '撤销', confirmed: true })).status).toBe(200);
    const [audit] = await x.sqlRows<{ after: { warnings: Record<string, unknown>[] } }>(
      sql`SELECT after FROM audit_events WHERE tenant_id=${x.session.tenant.id} AND object_id=${leave.id}
        AND action='employment.exit.over_capacity_confirmed'`,
    );
    expect(audit!.after.warnings[0]).toMatchObject({ capacityId: expect.any(String), peak: 2, limit: 1 });
  });
});
