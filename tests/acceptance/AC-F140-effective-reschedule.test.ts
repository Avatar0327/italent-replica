/** F-140b2：已生效离职的真实 HTTP 重定位 / 替代（普通角色 PG 与 PGlite）。 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
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
  it.each([
    ['2026-10-10', ['payroll', 'social_insurance']],
    ['2026-10-25', ['payroll', 'social_insurance', 'leave_balance', 'compensatory_leave', 'parental_leave']],
    [
      '2026-11-20',
      ['payroll', 'social_insurance', 'leave_balance', 'compensatory_leave', 'parental_leave', 'duty_transfer'],
    ],
  ] as const)('F-12：已生效改到 %s 的方向清单', async (last, kinds) => {
    const { x, leave } = await setup(`direction-${last}`);
    const result = await success(await patch(x, leave.id, last));
    expect(result.downstreamHints.probes.map((item: { kind: string }) => item.kind)).toEqual(kinds);
  });

  it('F-9：原单已作废的 T 不复活，重定位及撤销均列需重新发起', async () => {
    const x = await downstreamWorld(database().db, 'f140b2-voided');
    const leave = await x.directLeave('2026-10-15');
    const t = await x.transferIn('draft', '2026-10-20');
    await x.runScheduler('2026-10-16T02:00:00Z');
    expect(await x.stateOfBusiness(t.id)).toBe('voided');
    x.setNow('2026-11-05T02:00:00Z');
    const result = await success(await patch(x, leave.id, '2026-10-25'));
    expect(result.downstreamHints.items).toContainEqual(
      expect.objectContaining({
        kind: 'application_voided',
        targets: [expect.objectContaining({ id: t.id })],
      }),
    );
    await success(
      await x.session.request('POST', `/exits/${leave.id}/cancel`, {
        ifMatch: result.revision,
        body: { reason: '合成撤销' },
      }),
    );
    expect(await x.stateOfBusiness(t.id)).toBe('voided');
  });

  it.each(['2026-10-25', '2026-11-20'])('改到 %s 的 ΔO 跨停用拒绝，原单和后继均回滚', async (last) => {
    const { x, leave } = await setup(`disabled-${last}`);
    await seedLegacyOrgDeactivation(x, '2026-10-20', x.from);
    const before = await x.stateOf(x.employee.id);
    const response = await patch(x, leave.id, last);
    expect(response.status, await response.clone().text()).toBe(409);
    const after = await x.stateOf(x.employee.id);
    expect(after.businesses).toEqual(before.businesses);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.exits).toEqual(before.exits);
  });

  it('跨租户改期不可见，两边无写入', async () => {
    const { x, leave } = await setup('tenant-a');
    const { x: y } = await setup('tenant-b');
    const before = await x.stateOf(x.employee.id);
    const response = await y.session.request('PATCH', `/exits/${leave.id}`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { lastWorkDate: '2026-10-25' },
    });
    expect(response.status).toBe(404);
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
  });

  it('人工快照再次改期与幂等重放：版本递增，同一命令只发一次出口', async () => {
    const { x, leave } = await setup('repeat');
    const first = await success(await patch(x, leave.id, '2026-10-25'));
    const command = `f140b2-${leave.id}`;
    const send = () =>
      x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: first.revision,
        idempotencyKey: command,
        body: { lastWorkDate: '2026-10-22' },
      });
    const result = await success(await send());
    expect(await success(await send())).toEqual(result);
    expect((await x.versions(leave.id)).slice(-2)).toMatchObject([
      { planned: '2026-10-26' },
      { planned: '2026-10-23' },
    ]);
    expect(await x.audits(leave.id, 'employment.leave.replanned')).toHaveLength(2);
  });
  it('F-10：职责成功项不复制，失败项迁移到后继且旧项不能重试', async () => {
    const x = await downstreamWorld(database().db, 'f140b2-duty');
    const good = await x.peer('合成有效接收人'),
      bad = await x.peer('合成失效接收人');
    const one = await x.subordinateOf(x.employee.id, '合成下属一');
    const two = await x.subordinateOf(x.employee.id, '合成下属二');
    const leave = await x.directLeave('2026-10-15');
    await x.planDuties(leave.id, [
      { employeeId: one.id, receiverId: good.id },
      { employeeId: two.id, receiverId: bad.id },
    ]);
    await x.directLeave('2026-10-12', undefined, bad.id);
    await x.runScheduler('2026-10-13T01:00:00Z');
    await x.runScheduler('2026-10-16T01:00:00Z');
    expect((await x.items(leave.id)).map((item) => item.status).sort()).toEqual(['failed', 'succeeded']);
    x.setNow('2026-11-05T02:00:00Z');
    const result = await success(await patch(x, leave.id, '2026-11-20'));
    expect((await x.items(leave.id)).map((item) => item.status).sort()).toEqual(['succeeded', 'superseded']);
    const copied = await x.sqlRows<{ employee: string }>(sql`SELECT d.subordinate_id::text AS employee
      FROM transfer_linkage_duties d JOIN transfer_linkage_versions v ON v.tenant_id=d.tenant_id AND v.id=d.version_id
      WHERE v.tenant_id=${x.session.tenant.id} AND v.business_id=${result.successor.id}::uuid`);
    expect(copied).toEqual([{ employee: two.id }]);
    expect(await x.managerOf(one.id, '2026-11-05')).toBe(good.id);
  });

  it('F-10：连续替代保留后继链，已作废申请仍在后继撤销清单中', async () => {
    const x = await downstreamWorld(database().db, 'f140b2-chain');
    const leave = await x.directLeave('2026-10-15');
    const t = await x.transferIn('draft', '2026-10-20');
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const result = await success(await patch(x, leave.id, '2026-11-20'));
    await x.runScheduler('2026-11-21T02:00:00Z');
    x.setNow('2026-11-22T02:00:00Z');
    const second = await success(await patch(x, result.successor.id, '2026-12-01'));
    const cancelled = await success(
      await x.session.request('POST', `/exits/${second.successor.id}/cancel`, {
        ifMatch: second.successor.revision,
        body: { reason: '合成后继撤销' },
      }),
    );
    expect(JSON.stringify(cancelled)).toContain(t.id);
    expect(await x.stateOfBusiness(t.id)).toBe('voided');
  });
  it('摘下的未来 T 随新 L 挂回；多次改期与撤销不重复挂回', async () => {
    const x = await cancelWorld(database().db, 'f140b2-detached');
    const t = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-15');
    await x.runScheduler('2026-10-16T02:00:00Z');
    expect((await x.timeline()).some((r) => r.record_id === t.id)).toBe(false);
    x.setNow('2026-11-05T02:00:00Z');
    await success(await patch(x, leave.id, '2026-10-21'));
    expect((await x.timeline()).some((r) => r.record_id === t.id)).toBe(false);
    await success(await patch(x, leave.id, '2026-10-29'));
    expect((await x.timeline()).map((r) => r.record_id)).toContain(t.id);
    await x.cancelled(leave.id);
    expect((await x.timeline()).filter((r) => r.record_id === t.id)).toHaveLength(1);
  });

  it.each(['2026-10-25', '2026-11-20'])('整体 ΔP：改到 %s 按 R 是否变化决定新增预占', async (last) => {
    const x = await cancelWorld(database().db, `f140b2-capacity-${last}`);
    const other = await x.newcomer('合成占编员工');
    const leave = await x.directLeave('2026-10-15');
    expect((await x.transferInto(other.id, x.from.id, '2026-10-18')).status).toBe(201);
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const before = await x.stateOf(x.employee.id);
    if (last === '2026-10-25') {
      await success(await patch(x, leave.id, last));
      expect(await x.auditActions(leave.id)).not.toContain('employment.exit.over_capacity_confirmed');
      return;
    }
    expect(await x.reason(await patch(x, leave.id, last))).toMatchObject({
      status: 409,
      reason: 'CONFIRMATION_REQUIRED',
    });
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
    await success(await patch(x, leave.id, last, { confirmed: true }));
    expect(await x.auditActions(leave.id)).toContain('employment.exit.over_capacity_confirmed');
  });
});
