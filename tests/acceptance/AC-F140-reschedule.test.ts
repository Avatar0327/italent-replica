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
    const settings = await x.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: true, autoPopulate: false },
    });
    expect(settings.status).toBe(200);
    const t = await x.apply(x.employee.id, planned, { departmentId: x.to.id, place: '调动地点' });
    await x.approve(t, '2026-10-06T03:00:00Z');
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({ activated: [t.id] });
    at(x, '2026-11-01');
    const leave = await x.createdLeave(x.employee.id, {
      ...leaveBody('2026-11-09', 'direct'),
      formId: 'ungrouped-custom',
    });
    await changed(x, leave.id, '2026-11-01', '2026-10-19');
    const chain = await x.timeline();
    expect(chain.map((r) => r.kind)).toEqual(
      planned === '2026-10-25' ? ['hire', 'leave'] : ['hire', 'transfer', 'leave'],
    );
    expect((await x.session.record(leave.id, '2026-11-01')).fields.place).toBe(
      planned === '2026-10-25' ? '原地点' : '调动地点',
    );
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

  it.each(['scheduler', 'retry'])('F-14 / Q-4：失败改到未来，只有这一笔业务也能由 %s 生效', async (entry) => {
    const x = await world(`f14-${entry}`);
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
    if (entry === 'scheduler')
      expect(await x.runScheduler('2026-10-30T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    else {
      expect((await x.retry(leave, '2026-10-29T01:00:00Z')).status).toBe(409);
      expect((await x.retry(leave, '2026-10-30T01:00:00Z')).status).toBe(200);
      expect(await x.stateOfBusiness(leave.id)).toBe('effective');
    }
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
    const body = await todos.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: leave.id });
    expect(body.items[0].activation).toMatchObject({
      failureReason: 'EXIT_LATER_RECORD_EXISTS',
      details: {
        title: '离职暂无法生效',
        records: [{ docId: regular.id }],
      },
    });
  });
});

describe('F-140b1 事务与边界', () => {
  it.each([
    ['2026-10-15', '2026-10-06', '2026-10-10', ['payroll', 'social_insurance']],
    [
      '2026-10-15',
      '2026-11-01',
      '2026-10-25',
      ['payroll', 'social_insurance', 'leave_balance', 'compensatory_leave', 'parental_leave'],
    ],
    [
      '2026-10-15',
      '2026-10-06',
      '2026-10-29',
      ['payroll', 'social_insurance', 'leave_balance', 'compensatory_leave', 'parental_leave', 'duty_transfer'],
    ],
  ] as const)('F-12 未生效：原 L=%s、今天=%s、新 L=%s，只返回命中与连接状态', async (old, today, next, kinds) => {
    const x = await world(`hints-${next}`);
    const leave = await x.directLeave(old);
    const result = await changed(x, leave.id, today, next);
    expect(result.downstreamHints.items).toEqual([]);
    expect(result.downstreamHints.probes.map((p: { kind: string }) => p.kind)).toEqual(kinds);
    expect(result.downstreamHints.probes.find((p: { kind: string }) => p.kind === 'social_insurance').status).toBe(
      'not_connected',
    );
  });

  it('跨租户改期 404，两边计划与尝试都不变', async () => {
    const x = await world('tenant-a'),
      y = await world('tenant-b');
    const leave = await x.directLeave('2026-10-15');
    const before = await x.stateOf(x.employee.id);
    const response = await y.session.request('PATCH', `/exits/${leave.id}`, {
      ifMatch: leave.revision,
      body: { lastWorkDate: '2026-10-29' },
    });
    expect(response.status).toBe(404);
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
    expect((await x.stateOf(x.employee.id)).outboxEvents).toEqual(before.outboxEvents);
  });

  it('出口在同一事务内、失败全回滚；相同命令重放不重复调用', async () => {
    const x = await world('hook');
    const leave = await x.directLeave('2026-10-15');
    const { exitPostEffectHooks } = await import('../../apps/api/src/modules/employment/exit-confirmation.js');
    const { AppError } = await import('../../apps/api/src/errors.js');
    let reject = true,
      calls = 0;
    exitPostEffectHooks.onReplanned(async (tx, ctx, event) => {
      if (event.businessId !== leave.id) return;
      calls++;
      expect(event).toMatchObject({
        tenantId: x.session.tenant.id,
        employeeId: x.employee.id,
        fromPlanned: '2026-10-16',
        toPlanned: '2026-10-30',
        versionNo: 2,
      });
      const rows = await tx.execute(sql`SELECT planned_effective_date::text AS planned FROM employment_payload_versions
        WHERE tenant_id=${ctx.tenantId} AND business_id=${event.businessId}::uuid ORDER BY version_no DESC LIMIT 1`);
      expect(JSON.stringify(rows)).toContain('2026-10-30');
      if (reject) throw new AppError('CONFLICT', '合成订阅方拒绝');
    });
    const before = await x.stateOf(x.employee.id);
    expect((await patch(x, leave.id, '2026-10-29')).status).toBe(409);
    const after = await x.stateOf(x.employee.id);
    expect(after.businesses).toEqual(before.businesses);
    expect(after.outboxEvents).toEqual(before.outboxEvents);
    reject = false;
    const key = randomUUID();
    const send = () =>
      x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: leave.revision,
        idempotencyKey: key,
        body: { lastWorkDate: '2026-10-29' },
      });
    const first = await send(),
      replay = await send();
    expect(first.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(calls).toBe(2);
    expect(await x.versions(leave.id)).toHaveLength(2);
  });

  it('DEC-688 相关失败虽豁免逾期，改晚跨停用仍整体拒绝', async () => {
    const { x, leave } = await failedPair('related-occupancy');
    await seedLegacyOrgDeactivation(x, '2026-11-05', x.from);
    await seedLegacyOrgDeactivation(x, '2026-11-05', x.to);
    at(x, '2026-11-01');
    const before = await x.stateOf(x.employee.id);
    expect(await x.reason(await patch(x, leave.id, '2026-11-19'))).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
    });
    const after = await x.stateOf(x.employee.id);
    expect(after.businesses).toEqual(before.businesses);
    expect(after.attempts).toEqual(before.attempts);
  });
  it('同计划日期不是改期：日期单独重提不写载荷、尝试或事件', async () => {
    const x = await world('same-plan');
    const leave = await x.directLeave('2026-10-15');
    const before = await x.stateOf(x.employee.id);
    const response = await patch(x, leave.id, '2026-10-15');
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await x.stateOf(x.employee.id);
    expect(after.businesses).toEqual(before.businesses);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.outboxEvents).toEqual(before.outboxEvents);
  });

  it('F-16 改期路径：0d 失败前不作废草稿；再改到转正后可正常生效', async () => {
    const x = await world('f16-replan');
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
    const leave = await x.directLeave('2026-11-19');
    const draft = await x.transferIn('draft', '2026-12-01');
    await changed(x, leave.id, '2026-10-06', '2026-10-19');
    const before = await x.timeline();
    expect(await x.runScheduler('2026-10-20T01:00:00Z')).toMatchObject({ failed: [leave.id] });
    expect(await x.timeline()).toEqual(before);
    expect(await x.stateOfBusiness(draft.id)).toBe('draft');
    const detail = await x.session.request('GET', `/exits/${leave.id}`);
    expect((await detail.json()).activation.details).toMatchObject({
      records: [{ docId: regular.id, bizType: 'regularization', effectiveDate: '2026-11-10' }],
      message:
        '该员工在离职日期 2026-10-19 之后存在 1 条已生效的人事记录，离职生效后这些记录会与离职状态冲突。请先处理以下记录（撤销，或将生效日期调整到离职日期之前），再重新提交离职生效。',
      actions: ['查看记录', '关闭'],
    });
    const limited = x.restricted(() => true, undefined, ['activation']);
    for (const path of [`/exits/${leave.id}`, `/businesses/${leave.id}`, '/activation-todos']) {
      const response = await limited('GET', path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(regular.id);
      expect(text).not.toContain('2026-11-10');
      expect(text).not.toContain('2026-10-19');
    }
    await changed(x, leave.id, '2026-10-21', '2026-11-14');
    expect(await x.runScheduler('2026-11-15T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect(await x.stateOfBusiness(draft.id)).toBe('voided');
  });

  it('单调护栏拒绝向已有版本间隙倒插，普通角色也不能绕过', async () => {
    const x = await world('version-guard');
    const leave = await x.directLeave('2026-10-15');
    const insert = (version: number) =>
      withTenant(x.db, x.session.tenant.id, async (tx) => {
        await tx.execute(sql`INSERT INTO employment_payload_versions
        (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,planned_effective_date,form_id)
        SELECT ${randomUUID()}::uuid,tenant_id,employee_id,business_id,${version},kind,mode,effective_date,
          planned_effective_date,form_id FROM employment_payload_versions
        WHERE tenant_id=${x.session.tenant.id} AND business_id=${leave.id}::uuid ORDER BY version_no DESC LIMIT 1`);
      });
    await insert(10);
    await expect(insert(9)).rejects.toThrow();
    expect((await x.versions(leave.id)).map((v) => v.version_no)).toEqual([1, 10]);
  });
  it('DEC-688 suspended 分支只认本离职，放行后仍须新令牌确认', async () => {
    const x = await world('suspended-exception');
    const leave = await x.directLeave('2026-10-15');
    const transfer = await x.transferIn('approved', '2026-10-20');
    expect(await x.runScheduler('2026-11-01T01:00:00Z')).toMatchObject({
      failed: [leave.id],
      suspended: [transfer.id],
    });
    at(x, '2026-11-01');
    const before = await x.stateOf(x.employee.id);
    const token = await ack(x, leave.id, '2026-10-17');
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
    await changed(x, leave.id, '2026-11-01', '2026-10-17', token);
    expect(await latest(x, transfer.id)).toMatchObject({ outcome: 'replanned' });
    expect(await latest(x, leave.id)).toMatchObject({ outcome: 'failed', reason: 'REBUILD_REQUIRED' });
  });

  it('F-140 通用草稿编辑：确认令牌不是业务字段，确认后重提成功', async () => {
    const x = await world('generic-ack');
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-15'));
    await x.transferIn('in_review', '2026-10-20');
    const send = (extra = {}) =>
      x.session.request('PATCH', `/businesses/${leave.id}`, {
        ifMatch: leave.revision,
        body: { lastWorkDate: '2026-10-29', ...extra },
      });
    const failure = await x.reason(await send());
    expect(failure).toMatchObject({ status: 409, reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED' });
    const response = await send({ pendingTransferAck: failure.ackToken });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await x.business(leave.id)).effectiveDate).toBe('2026-10-30');
  });

  it('Q-2 / Q-3：改晚解除依赖，两笔重新排队，不把 replanned 当失败前序', async () => {
    const { x, leave, transfer } = await failedPair('replanned-queue');
    await changed(x, leave.id, '2026-11-01', '2026-11-19');
    expect(await latest(x, transfer.id)).toMatchObject({ outcome: 'replanned' });
    expect(await x.runScheduler('2026-11-01T03:00:00Z')).toMatchObject({ activated: [transfer.id], suspended: [] });
    expect(await x.runScheduler('2026-11-20T01:00:00Z')).toMatchObject({ activated: [leave.id], failed: [] });
  });

  it('Q-5 effective 分支：关联的已落地调动标为 replanned 后详情没有旧失败标记', async () => {
    const x = await world('effective-summary');
    const employee = await x.session.getEmployee(x.employee.id);
    const transfer = await x.session.business(
      x.employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-25',
        fields: { departmentId: x.to.id },
      },
      employee.revision,
    );
    const leave = await x.directLeave('2026-10-15');
    const ctx = context(x, '2026-10-06');
    await withTenant(x.db, ctx.tenantId, async (tx) => {
      const item = (await pendingActivations(tx, ctx, x.employee.id)).find((row) => row.id === transfer.id)!;
      await recordActivationAttempt(tx, ctx, item, {
        outcome: 'failed',
        trigger: 'scheduler',
        reason: 'REBUILD_REQUIRED',
        detail: { blockers: [{ id: leave.id }] },
      });
    });
    await changed(x, leave.id, '2026-10-08', '2026-10-29');
    expect(await latest(x, transfer.id)).toMatchObject({ outcome: 'replanned' });
    expect((await x.business(transfer.id)).activation).toBeNull();
    expect(await x.todos()).toEqual([]);
  });
  it('F-140 混合编辑：立即生效的订阅方必须看到本次扩展字段', async () => {
    const x = await world('mixed-fields');
    const leave = await x.directLeave('2026-11-19');
    const { exitPostEffectHooks } = await import('../../apps/api/src/modules/employment/exit-confirmation.js');
    let observed: unknown;
    exitPostEffectHooks.onEffective(async (tx, ctx, event) => {
      if (event.businessId !== leave.id) return;
      const rows = await tx.execute(sql`SELECT exit_type_code FROM exit_requests
        WHERE tenant_id=${ctx.tenantId} AND business_id=${leave.id}::uuid`);
      observed = JSON.stringify(rows);
    });
    await changed(x, leave.id, '2026-11-01', '2026-10-29', { exitTypeCode: 'involuntary' });
    expect(observed).toContain('involuntary');
  });

  it('F-11 已生效的仅生效日改动仍返回原日期不可改原因', async () => {
    const x = await world('immutable-effective-only');
    const leave = await x.directLeave('2026-10-15');
    await x.runScheduler('2026-10-16T01:00:00Z');
    const before = await x.stateOf(x.employee.id);
    const response = await x.session.request('PATCH', `/exits/${leave.id}`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { effectiveDate: '2026-10-30' },
    });
    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'EXIT_DATE_IMMUTABLE' });
    expect((await x.stateOf(x.employee.id)).businesses).toEqual(before.businesses);
  });
});
