/** F-140b2：已生效离职的真实 HTTP 重定位 / 替代（普通角色 PG 与 PGlite）。 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { registerEmployeeStatusHooks } from '../../apps/api/src/modules/employment/status-hooks.js';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof downstreamWorld>>;
async function setup(label: string) {
  const x = await downstreamWorld(database().db, `f140b2-${label}`);
  const leave = await x.directLeave('2026-10-15');
  expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [leave.id] });
  x.setNow('2026-11-05T02:00:00Z');
  return { x, leave };
}
async function patch(x: World, id: string, date: string, extra = {}) {
  return x.session.request('PATCH', `/exits/${id}`, {
    ifMatch: (await x.business(id)).revision,
    body: { lastWorkDate: date, ...extra },
  });
}
async function success(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

describe('F-140b2 已生效离职', () => {
  it('F-9 / F-13：同业务人工快照重定位，钩子恰一次且在事务中；之后可以撤销', async () => {
    const { x, leave } = await setup('reposition');
    const release = (await x.exitRow(leave.id))!.pre_release_date;
    const calls: unknown[] = [];
    registerEmployeeStatusHooks(`f140b2-${leave.id}`, {
      async onRecordRescheduled(tx, ctx, event) {
        if (event.after.recordId !== leave.id) return;
        const written = await tx.execute(sql`SELECT start_date::text AS day FROM employment_timeline
          WHERE tenant_id=${ctx.tenantId} AND record_id=${leave.id}::uuid`);
        calls.push({ event, rows: x.rowsOf(written) });
      },
    });
    const replanned: unknown[] = [];
    exitPostEffectHooks.onReplanned(async (_tx, _ctx, event) => {
      if (event.businessId === leave.id) replanned.push(event);
    });
    const result = await success(await patch(x, leave.id, '2026-10-25'));
    expect(result).toMatchObject({ id: leave.id, status: 'effective', effectiveDate: '2026-10-26' });
    expect((await x.versions(leave.id)).at(-1)).toMatchObject({ planned: '2026-10-26' });
    expect((await x.exitRow(leave.id))!.pre_release_date).toEqual(release);
    expect(calls).toEqual([
      {
        event: {
          before: expect.objectContaining({ recordId: leave.id, effectiveDate: '2026-10-16' }),
          after: expect.objectContaining({ recordId: leave.id, effectiveDate: '2026-10-26' }),
        },
        rows: [{ day: '2026-10-26' }],
      },
    ]);
    expect(replanned).toEqual([
      expect.objectContaining({
        fromPlanned: '2026-10-16',
        toPlanned: '2026-10-26',
        versionNo: expect.any(Number),
      }),
    ]);
    const cancelled = await x.session.request('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: result.revision,
      body: { reason: '合成重定位后撤销' },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect((await x.timeline()).map((r) => r.kind)).toEqual(['hire']);
  });

  it('F-10：改到未来原单撤销、后继 approved，R 重定，后继由调度生效', async () => {
    const { x, leave } = await setup('replace');
    const calls: unknown[] = [];
    registerEmployeeStatusHooks(`f140b2-${leave.id}`, {
      async onRecordRescheduled(_tx, _ctx, event) {
        if (event.before.recordId === leave.id) calls.push(event);
      },
    });
    const result = await success(await patch(x, leave.id, '2026-11-20'));
    const next = result.successor;
    expect(next).toMatchObject({ id: expect.any(String), status: 'approved', effectiveDate: '2026-11-21' });
    expect(next.id).not.toBe(leave.id);
    expect(await x.stateOfBusiness(leave.id)).toBe('deleted');
    const rows = await x.sqlRows(sql`SELECT supersedes_business_id::text AS previous, pre_release_date::text AS r
      FROM exit_requests WHERE tenant_id=${x.session.tenant.id} AND business_id=${next.id}::uuid`);
    expect(rows).toEqual([{ previous: leave.id, r: '2026-11-05' }]);
    expect(calls).toEqual([]);
    expect(await x.runScheduler('2026-11-21T02:00:00Z')).toMatchObject({ activated: [next.id] });
  });

  it('F-13：订阅失败回滚人工版本、时间轴和审计', async () => {
    const { x, leave } = await setup('rollback');
    const before = { versions: await x.versions(leave.id), timeline: await x.timeline() };
    registerEmployeeStatusHooks(`f140b2-${leave.id}`, {
      async onRecordRescheduled(_tx, _ctx, event) {
        if (event.before.recordId === leave.id) throw new Error('合成订阅存储失败');
      },
    });
    const response = await patch(x, leave.id, '2026-10-25');
    expect(response.status).toBe(500);
    expect({ versions: await x.versions(leave.id), timeline: await x.timeline() }).toEqual(before);
  });

  it('改早跨过同周期记录返回 EXIT_RESCHEDULE_CROSSES_RECORD，全部不变', async () => {
    const x = await downstreamWorld(database().db, 'f140b2-cross');
    const t = await x.transferIn('approved', '2026-10-10');
    expect(await x.runScheduler('2026-10-10T02:00:00Z')).toMatchObject({ activated: [t.id] });
    x.setNow('2026-10-11T02:00:00Z');
    const leave = await x.directLeave('2026-10-15');
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const before = await x.timeline();
    expect(await x.reason(await patch(x, leave.id, '2026-10-08'))).toMatchObject({
      status: 409,
      reason: 'EXIT_RESCHEDULE_CROSSES_RECORD',
    });
    expect(await x.timeline()).toEqual(before);
  });
});
