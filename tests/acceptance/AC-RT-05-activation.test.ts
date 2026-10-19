/**
 * R2-T04 BE-5a / AC-RT-05、08（顺延重派生）、10（生效侧）、12：退休生效走离职的同一个 activateExit（设计 §4）。
 * 审批通过、调度、HR 重试三个入口都落地；预减（R）在审批通过当日写；迟到按 C-1 / C-2 顺延（DEC-638 A-15），
 * 实际退休日期 = 最终生效日 E′，类型按快照 P 重新派生；事件带 kind / reEmployed（c3，只发形状不执行交接）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  exitPostEffectHooks,
  type ExitConfirmedEvent,
  type ExitEffectiveEvent,
} from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { tenantApi } from './support/tenant-api.js';
import { retireBody, retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementWorld(database().db, label, TODAY);

const confirmed: ExitConfirmedEvent[] = [];
const effective: ExitEffectiveEvent[] = [];
exitPostEffectHooks.onConfirmed(async (_tx, _ctx, event) => void confirmed.push(event));
exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => void effective.push(event));

describe('AC-RT-05 三个入口都经 activateExit', () => {
  it('审批通过且 E ≤ 今天：审批事务内生效，类型 / 状态 / 实际退休日期 / 审计名都是退休的', async () => {
    const x = await world('rt05-approve');
    await x.setExpectedRetirement('2026-10-05');
    const draft = await x.submittedRetire('2026-10-05');
    const approved = await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect(approved.status).toBe('effective');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    expect(await x.employeeStatusOf(draft.id)).toBe(6);
    const [effectiveAudit] = await x.audits(draft.id, 'employment.retirement.effective');
    expect(effectiveAudit!.after).toMatchObject({ source: 'approval' });
    expect(await x.audits(draft.id, 'employment.exit.effective')).toEqual([]);
    expect(await x.audits(draft.id, 'retirement.actual_date.synced')).toHaveLength(1);
    expect((await x.retirementDates()).actual).toBe(TODAY);
    expect(await x.versions(draft.id)).toHaveLength(1);
    expect(await x.attempts(draft.id)).toEqual([]);
  });

  it('审批通过当日写编制预减时点 R；E 未到停在 approved，调度到期当天原子生效并写实际退休日期 = E', async () => {
    const x = await world('rt05-scheduler');
    const draft = await x.submittedRetire('2026-10-20');
    expect((await x.approve(draft, `${TODAY}T02:00:00Z`)).status).toBe('approved');
    expect(await x.exitRow(draft.id)).toMatchObject({ pre_release_date: TODAY });
    expect((await x.effects(draft.id)).map((row) => [row.phase, row.kind])).toEqual([
      ['confirmed', 'establishment_pre_released'],
    ]);
    expect((await x.retirementDates()).actual).toBeNull();
    expect(await x.runScheduler('2026-10-20T01:00:00Z')).toMatchObject({ activated: [] });
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [draft.id], failed: [] });
    expect((await x.business(draft.id)).status).toBe('effective');
    expect((await x.attempts(draft.id)).map((row) => row.outcome)).toEqual(['effective']);
    expect((await x.timeline()).at(-1)).toMatchObject({ kind: 'retirement', start_date: '2026-10-21' });
    expect((await x.retirementDates()).actual).toBe('2026-10-21');
  });

  it('直接退休未到期出现在待生效队列；前序调动未执行时不越过（排序与离职同一规则）', async () => {
    const x = await world('rt05-queue');
    const transfer = await x.transferIn('approved', '2026-10-07');
    const retire = await x.directRetire('2026-10-07');
    expect(retire.status).toBe('approved');
    expect(await x.runScheduler('2026-10-08T03:00:00Z')).toMatchObject({ activated: [transfer.id, retire.id] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'transfer', 'retirement']);
  });

  it('迟到顺延（A-15）：L′ = a − 1、E′ = a，追加系统修订版本；实际退休日期 = E′；审计名是 retirement.rescheduled', async () => {
    const x = await world('rt05-late');
    const retire = await x.directRetire('2026-10-15');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [retire.id] });
    expect((await x.versions(retire.id)).map((v) => [v.version_no, v.effective_date, v.last_work_date])).toEqual([
      [1, '2026-10-16', '2026-10-15'],
      [2, '2026-10-18', '2026-10-17'],
    ]);
    expect((await x.audits(retire.id, 'employment.retirement.rescheduled'))[0]!.after).toMatchObject({
      reason: 'late-execution',
      originalLastWorkDate: '2026-10-15',
      lastWorkDate: '2026-10-17',
      effectiveDate: '2026-10-18',
    });
    expect(await x.audits(retire.id, 'employment.leave.rescheduled')).toEqual([]);
    expect((await x.timeline()).at(-1)).toMatchObject({ kind: 'retirement', start_date: '2026-10-18' });
    expect((await x.retirementDates()).actual).toBe('2026-10-18');
  });

  it('HR 重试：生效失败（顺延区间内有未落地调动）→ 待办；删除阻塞后经 activation/retry 生效', async () => {
    const x = await world('rt05-retry');
    const retire = await x.directRetire('2026-10-15');
    const blocker = await x.transferIn('draft', '2026-10-17');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [retire.id] });
    expect((await x.attempts(retire.id)).map((row) => [row.outcome, row.reason])).toEqual([
      ['failed', 'REBUILD_REQUIRED'],
    ]);
    expect((await x.todos()).map((todo) => todo.id)).toContain(retire.id);
    x.setNow('2026-10-18T02:00:00Z');
    const removed = await x.session.request('DELETE', `/businesses/${blocker.id}`, { ifMatch: blocker.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const retried = await x.retry(retire, '2026-10-18T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.business(retire.id)).status).toBe('effective');
    expect((await x.retirementDates()).actual).toBe('2026-10-18');
  });
});

describe('AC-RT-08 顺延后按快照 P 重新派生退休类型', () => {
  it('创建时 L = P → normal；顺延使 L′ > P → delayed；创建后人事 P 再变不影响', async () => {
    const x = await world('rt08-postpone');
    await x.setExpectedRetirement('2026-10-15');
    const retire = await x.directRetire('2026-10-15');
    expect((await x.retirementRow(retire.id))!.retire_type).toBe('normal');
    await x.setExpectedRetirement('2035-01-01');
    await x.runScheduler('2026-10-18T01:00:00Z');
    expect(await x.retirementRow(retire.id)).toMatchObject({
      expected_retirement_date: '2026-10-15',
      retire_type: 'delayed',
    });
  });

  it('不顺延时类型保持创建时的值；P 为空始终为空', async () => {
    const x = await world('rt08-nopostpone');
    await x.setExpectedRetirement('2026-10-20');
    const retire = await x.directRetire('2026-10-15');
    await x.runScheduler('2026-10-16T01:00:00Z');
    expect((await x.retirementRow(retire.id))!.retire_type).toBe('early');
    const y = await world('rt08-null');
    const none = await y.directRetire('2026-10-15');
    await y.runScheduler('2026-10-18T01:00:00Z');
    expect((await y.retirementRow(none.id))!.retire_type).toBeNull();
  });
});

describe('AC-RT-10 实际退休日期是系统字段', () => {
  it('人事 PATCH 改 actualRetirementDate → 400；预计退休日期仍可手改', async () => {
    const x = await world('rt10-system');
    const api = tenantApi(x.db, { clock: () => new Date(`${TODAY}T01:00:00Z`) });
    const as = { user: x.session.user.id, tenant: x.session.tenant.id };
    const path = `/api/tenant/personnel/employees/${x.employee.id}`;
    const current = (await (await api.request('GET', path, as)).json()) as { revision: number };
    const denied = await api.request('PATCH', path, {
      ...as,
      ifMatch: current.revision,
      body: { actualRetirementDate: '2030-01-01' },
    });
    expect(denied.status).toBe(400);
    expect((await x.retirementDates()).actual).toBeNull();
    const allowed = await api.request('PATCH', path, {
      ...as,
      ifMatch: current.revision,
      body: { expectedRetirementDate: '2030-01-01' },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });
});

describe('AC-RT-12 事件形状（c3：只发形状，不执行交接）', () => {
  it('申请审批通过调 confirmed 端口一次，事件 kind = retirement；直接退休不调；生效事件带 kind / reEmployed', async () => {
    const x = await world('rt12-events');
    const draft = await x.submittedRetire('2026-10-20');
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect(confirmed.filter((event) => event.businessId === draft.id)).toEqual([
      { businessId: draft.id, employeeId: x.employee.id, mode: 'application', kind: 'retirement', reEmployed: false },
    ]);
    await x.runScheduler('2026-10-21T01:00:00Z');
    expect(effective.filter((event) => event.businessId === draft.id)).toMatchObject([
      { kind: 'retirement', reEmployed: false, source: 'approval', lastWorkDate: '2026-10-20' },
    ]);

    const y = await world('rt12-direct');
    const direct = await y.createdRetire(y.employee.id, retireBody('2026-10-05', 'direct'));
    expect(direct.status).toBe('effective');
    expect(confirmed.filter((event) => event.businessId === direct.id)).toEqual([]);
    expect(effective.filter((event) => event.businessId === direct.id)).toMatchObject([
      { kind: 'retirement', reEmployed: false, source: 'direct' },
    ]);
  });
});
