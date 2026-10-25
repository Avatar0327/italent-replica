/** F-140b1 / DEC-687、688：真实 HTTP 改期 → 审批 / 调度 / 重试；同一文件跑 PG app_owner 与 PGlite。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';
import { pendingActivations, recordActivationAttempt } from '../../apps/api/src/modules/employment/activation-store.js';

const database = useTestDb();
const world = (label: string) => downstreamWorld(database().db, `f140-${label}`);
type World = Awaited<ReturnType<typeof world>>;
const at = (x: World, day: string) => x.setNow(`${day}T02:00:00Z`);
const context = (x: World, day: string) => ({
  tenantId: x.session.tenant.id,
  userId: x.session.user.id,
  timezone: x.session.tenant.timezone,
  now: new Date(`${day}T02:00:00Z`),
  commandId: randomUUID(),
  expectedRevision: 0,
});
async function patch(x: World, id: string, lastWorkDate: string, extra = {}) {
  return x.session.request('PATCH', `/exits/${id}`, {
    ifMatch: (await x.business(id)).revision,
    body: { lastWorkDate, ...extra },
  });
}
async function changed(x: World, id: string, day: string, lastWorkDate: string, extra = {}) {
  at(x, day);
  const response = await patch(x, id, lastWorkDate, extra);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function ack(x: World, id: string, lastWorkDate: string) {
  const failure = await x.reason(await patch(x, id, lastWorkDate));
  expect(failure).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
  expect(failure.ackToken).toBeTruthy();
  return { pendingTransferAck: failure.ackToken };
}
const latest = async (x: World, id: string) => (await x.attempts(id)).at(-1);
async function failedPair(label: string) {
  const x = await world(label);
  const leave = await x.directLeave('2026-10-15');
  const transfer = await x.transferIn('approved', '2026-10-20');
  await changed(x, leave.id, '2026-10-08', '2026-10-29');
  expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({
    failed: [transfer.id],
    suspended: [leave.id],
  });
  return { x, leave, transfer };
}

describe('F-140b1 未生效改期与重新入队', () => {
  it.each([
    ['F-1', '2026-10-29'],
    ['F-3', '2026-10-24'],
  ])('%s：改晚、停调度到 11-01', async (name, last) => {
    const x = await world(name!);
    const leave = await x.directLeave('2026-10-15');
    const transfer = await x.transferIn('approved', '2026-10-20');
    const release = (await x.exitRow(leave.id))!.pre_release_date;
    await changed(x, leave.id, '2026-10-08', '2026-10-29');
    if (name === 'F-3') await changed(x, leave.id, '2026-10-09', last!);
    expect((await x.versions(leave.id)).at(-1)!.planned).toBe(name === 'F-1' ? '2026-10-30' : '2026-10-25');
    expect((await x.exitRow(leave.id))!.pre_release_date).toEqual(release);
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({
      failed: [transfer.id],
      suspended: [leave.id],
    });
    expect(await x.stateOfBusiness(transfer.id)).toBe('approved');
  });

  it('F-2：改早跨过 T，确认后共同迟到，两笔留给 HR', async () => {
    const x = await world('f2');
    const leave = await x.directLeave('2026-10-15');
    const transfer = await x.transferIn('approved', '2026-10-20');
    await changed(x, leave.id, '2026-10-08', '2026-10-29');
    at(x, '2026-10-09');
    await changed(x, leave.id, '2026-10-09', '2026-10-15', await ack(x, leave.id, '2026-10-15'));
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({
      failed: [leave.id],
      suspended: [transfer.id],
    });
  });

  it('F-4：人工版本与立即顺延共用时间戳，version_no 递增，计划不被顺延覆盖', async () => {
    const x = await world('f4');
    const leave = await x.directLeave('2026-11-09');
    const result = await changed(x, leave.id, '2026-11-01', '2026-10-19');
    expect(result.status).toBe('effective');
    const versions = await x.versions(leave.id);
    expect(versions.slice(-2)).toMatchObject([
      { effective_date: '2026-10-20', planned: '2026-10-20' },
      { effective_date: '2026-11-01', planned: '2026-10-20' },
    ]);
    expect(versions.at(-1)!.version_no).toBe(versions.at(-2)!.version_no + 1);
    const times = await x.sqlRows<{ n: number }>(sql`SELECT count(DISTINCT created_at)::int AS n
      FROM employment_payload_versions WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid
      AND version_no>${versions[0]!.version_no}`);
    expect(times[0]!.n).toBe(1);
    expect((await x.timeline()).at(-1)!.start_date).toBe('2026-11-01');
  });

  it.each(['2026-10-25', '2026-10-15'])('F-5：同日迟到调动计划 %s，按新计划定位并继承', async (planned) => {
    const x = await world(`f5-${planned}`);
    const t = await x.apply(x.employee.id, planned, { departmentId: x.to.id, place: '调动地点' });
    await x.approve(t, '2026-10-06T03:00:00Z');
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ activated: [t.id] });
    at(x, '2026-11-01');
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-11-09', 'direct'));
    await changed(x, leave.id, '2026-11-01', '2026-10-19');
    const chain = await x.timeline();
    expect(chain.map((r) => r.kind)).toEqual(
      planned === '2026-10-25' ? ['hire', 'leave'] : ['hire', 'transfer', 'leave'],
    );
    expect((await x.business(leave.id)).fields.place).toBe(planned === '2026-10-25' ? '原地点' : '调动地点');
  });

  it('F-6 / DEC-688：旧失败失效，R6 新失败立即有待办，T 下次调度重新挂起', async () => {
    const { x, leave, transfer } = await failedPair('f6');
    at(x, '2026-11-01');
    const before = await x.stateOf(x.employee.id);
    const token = await ack(x, leave.id, '2026-10-15');
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
    await changed(x, leave.id, '2026-11-01', '2026-10-15', token);
    expect((await x.attempts(leave.id)).map((r) => [r.outcome, r.reason])).toEqual([
      ['suspended', 'PREDECESSOR_FAILED'],
      ['replanned', 'REPLANNED'],
      ['failed', 'REBUILD_REQUIRED'],
    ]);
    expect((await x.attempts(transfer.id)).map((r) => [r.outcome, r.reason])).toEqual([
      ['failed', 'REBUILD_REQUIRED'],
      ['replanned', 'REPLANNED'],
    ]);
    expect((await x.todos()).map((r) => r.id)).toEqual([leave.id]);
    expect(await x.runScheduler('2026-11-01T04:00:00Z')).toMatchObject({ suspended: [transfer.id] });
    expect(await latest(x, transfer.id)).toMatchObject({ outcome: 'suspended', blocked_by_business_id: leave.id });
  });

  it.each([false, true])('F-7 / F-8：改期后撤销（共同迟到=%s），T 可落地', async (late) => {
    let x: World, leave: { id: string }, transfer: { id: string };
    if (late) ({ x, leave, transfer } = await failedPair('f8'));
    else {
      x = await world('f7');
      leave = await x.directLeave('2026-10-15');
      transfer = await x.transferIn('approved', '2026-10-20');
      await changed(x, leave.id, '2026-10-08', '2026-10-29');
    }
    at(x, late ? '2026-11-02' : '2026-10-09');
    const cancelled = await x.session.request('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '合成撤销原因' },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    if (late) expect((await x.retry(transfer, '2026-11-02T03:00:00Z')).status).toBe(200);
    else expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ activated: [transfer.id] });
    expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
  });

  it('F-14：失败改到未来，只有这一笔待生效的员工仍被调度选中', async () => {
    const x = await world('f14');
    const leave = await x.directLeave('2026-10-15');
    const draft = await x.synthetic(x.employee.id, {
      kind: 'regularization',
      state: 'draft',
      effectiveDate: '2026-10-17',
    });
    expect(await x.runScheduler('2026-10-20T01:00:00Z')).toMatchObject({ failed: [leave.id] });
    const del = await x.session.request('DELETE', `/businesses/${draft}`, {
      ifMatch: (await x.business(draft)).revision,
    });
    expect(del.status, await del.clone().text()).toBe(200);
    const result = await changed(x, leave.id, '2026-10-20', '2026-10-29');
    expect(result.activation).toMatchObject({ status: 'pending', failureReason: null });
    expect(await x.todos()).toEqual([]);
    expect(await x.runScheduler('2026-10-30T01:00:00Z')).toMatchObject({ activated: [leave.id] });
  });

  it('F-15：审批中 T 即使早于新 L 仍需确认，确认后成功', async () => {
    const x = await world('f15');
    const leave = await x.directLeave('2026-10-15');
    const t = await x.transferIn('in_review', '2026-10-20');
    at(x, '2026-10-10');
    const failure = await x.reason(await patch(x, leave.id, '2026-10-29'));
    expect(failure).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    expect(failure.items).toEqual(expect.arrayContaining([expect.objectContaining({ businessId: t.id })]));
    await changed(x, leave.id, '2026-10-10', '2026-10-29', { pendingTransferAck: failure.ackToken });
  });

  it.each(['draft', 'rejected', 'in_review'] as const)(
    '草稿 / 驳回 / 审批中 %s 写人工版本，审批读取新日期',
    async (state) => {
      const x = await world(state);
      const leave =
        state === 'draft'
          ? await x.createdLeave(x.employee.id, leaveBody('2026-10-15', 'application', { exitTypeCode: 'voluntary' }))
          : await x.submittedLeave('2026-10-15');
      if (state === 'rejected') await x.rejectInReview(leave.id);
      await changed(x, leave.id, '2026-10-08', '2026-10-29');
      expect((await x.versions(leave.id)).at(-1)!.planned).toBe('2026-10-30');
      expect(await x.stateOfBusiness(leave.id)).toBe(state);
      if (state === 'in_review') {
        await x.approve(leave, '2026-10-30T01:00:00Z');
        expect(await x.stateOfBusiness(leave.id)).toBe('effective');
      }
    },
  );

  it('F-11：通用 approved 改期、已生效离职改期仍拒绝且无业务写入', async () => {
    const x = await world('f11');
    const leave = await x.directLeave('2026-10-15');
    let before = await x.stateOf(x.employee.id);
    expect(
      await x.reason(
        await x.session.request('PATCH', `/businesses/${leave.id}`, {
          ifMatch: (await x.business(leave.id)).revision,
          body: { lastWorkDate: '2026-10-29' },
        }),
      ),
    ).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
    await x.runScheduler('2026-10-16T01:00:00Z');
    before = await x.stateOf(x.employee.id);
    at(x, '2026-10-17');
    expect(await x.reason(await patch(x, leave.id, '2026-10-29'))).toMatchObject({
      status: 400,
      reason: 'EXIT_DATE_IMMUTABLE',
    });
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
    expect((await x.stateOf(x.employee.id)).timeline).toEqual(before.timeline);
  });

  it.each(['unrelated', 'other-exit', 'other-reason'])('DEC-688：%s 逾期调动不豁免，409 无写入', async (mode) => {
    const x = await world(mode);
    const leave = await x.directLeave('2026-11-09');
    const t = await x.transferIn('approved', '2026-10-20');
    if (mode !== 'unrelated')
      await withTenant(x.db, x.session.tenant.id, async (tx) => {
        const ctx = context(x, '2026-11-01');
        const item = (await pendingActivations(tx, ctx, x.employee.id)).find((r) => r.id === t.id)!;
        await recordActivationAttempt(tx, ctx, item, {
          outcome: 'failed',
          trigger: 'scheduler',
          reason: mode === 'other-exit' ? 'REBUILD_REQUIRED' : 'TARGET_ORG_DISABLED',
          detail: { blockers: [{ id: mode === 'other-exit' ? randomUUID() : leave.id }] },
        });
      });
    at(x, '2026-11-01');
    const before = await x.stateOf(x.employee.id);
    expect(await x.reason(await patch(x, leave.id, '2026-11-19'))).toMatchObject({
      status: 409,
      reason: 'EXIT_LATE_TRANSFER_PENDING',
    });
    const after = await x.stateOf(x.employee.id);
    expect(after.businesses).toEqual(before.businesses);
    expect(after.outboxEvents).toEqual(before.outboxEvents);
  });

  it('改晚新增在职段跨部门停用仍拒绝，日期与尝试不变', async () => {
    const x = await world('occupancy');
    const leave = await x.directLeave('2026-10-15');
    await seedLegacyOrgDeactivation(x, '2026-10-20', x.from);
    at(x, '2026-10-08');
    const before = await x.stateOf(x.employee.id);
    const result = await patch(x, leave.id, '2026-10-29');
    expect(result.status, await result.clone().text()).toBe(409);
    const after = await x.stateOf(x.employee.id);
    expect(after.businesses).toEqual(before.businesses);
    expect(after.attempts).toEqual(before.attempts);
  });

  it('F-16：首次直接离职碰到未来已落地转正，生效前拦住且发起人有完整提示', async () => {
    const x = await world('f16');
    const employee = await x.session.getEmployee(x.employee.id);
    const regular = await x.session.business(
      x.employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-11-10',
        fields: {},
      },
      employee.revision,
    );
    const leave = await x.directLeave('2026-10-19');
    const before = await x.timeline();
    expect(await x.runScheduler('2026-10-20T01:00:00Z')).toMatchObject({ failed: [leave.id] });
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect(await x.timeline()).toEqual(before);
    expect(await latest(x, leave.id)).toMatchObject({
      outcome: 'failed',
      reason: 'EXIT_LATER_RECORD_EXISTS',
      detail: {
        records: [
          { bizType: 'regularization', effectiveDate: '2026-11-10', docId: regular.id, docNo: expect.any(String) },
        ],
      },
    });
    const todos = await x.session.request('GET', '/activation-todos');
    expect(await todos.json()).toMatchObject({
      items: [
        expect.objectContaining({
          id: leave.id,
          activation: {
            failureReason: 'EXIT_LATER_RECORD_EXISTS',
            details: {
              title: '离职暂无法生效',
              records: [expect.objectContaining({ docId: regular.id })],
            },
          },
        }),
      ],
    });
  });
});
