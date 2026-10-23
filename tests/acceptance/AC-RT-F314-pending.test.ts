/** DEC-677 / F-314：提前申请返聘，到期挂起、退休后顺延续办，关联退休作废则失败。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { retireBody, retirementWorld, type RetirementWorld } from './AC-RT-support.js';
import { withRehire } from './AC-RT-rehire-support.js';

const database = useTestDb();
const world = (label: string) => retirementWorld(database().db, `f314-${label}`);
const REQUIRED = 'RETIRE_REHIRE_REQUIRES_RETIREMENT';
const VOIDED = 'RETIRE_REHIRE_RETIREMENT_VOIDED';
const body = (date = '2026-10-18', mode = 'application') => ({
  kind: 'retire_rehire',
  mode,
  effectiveDate: date,
  fields: { employType: 'internal' },
});

async function create(x: RetirementWorld, date?: string, mode?: string) {
  const employee = await x.session.getEmployee(x.employee.id);
  return x.session.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: withLoginEmail(employee.id, body(date, mode)),
  });
}
async function draft(x: RetirementWorld, date?: string) {
  const response = await create(x, date);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}
async function submit(x: RetirementWorld, target: { id: string }) {
  const current = await x.business(target.id);
  const response = await x.session.request('POST', `/businesses/${target.id}/submit`, {
    ifMatch: current.revision,
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function approved(x: RetirementWorld, date?: string) {
  const target = await draft(x, date);
  await submit(x, target);
  await x.approve(target, '2026-10-06T02:00:00Z');
  return target;
}
async function cancel(x: RetirementWorld, id: string) {
  const response = await x.session.request('POST', `/retirements/${id}/cancel`, {
    ifMatch: (await x.business(id)).revision,
    body: { reason: '合成测试撤销退休' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function refused(x: RetirementWorld, response: Response) {
  const content = await response.clone().text();
  expect(await x.reason(response)).toMatchObject({ status: 409, code: 'CONFLICT', reason: REQUIRED });
  expect(content).toContain('须先发起退休');
}
async function suspended(x: RetirementWorld, id: string, retirementId: string) {
  expect((await x.business(id)).activation).toMatchObject({
    status: 'suspended',
    failureReason: REQUIRED,
    blockedByBusinessId: retirementId,
    failureCount: 0,
  });
  expect((await x.timeline()).some((row) => row.record_id === id)).toBe(false);
}
async function failed(x: RetirementWorld, id: string) {
  expect((await x.business(id)).activation).toMatchObject({ status: 'failed', failureReason: VOIDED });
  expect((await x.todos()).find((item) => item.id === id)?.activation).toMatchObject({
    status: 'failed',
    failureReason: VOIDED,
  });
  expect((await x.timeline()).some((row) => row.record_id === id)).toBe(false);
}

describe('AC-RT-F314 发起与只读预览', () => {
  it.each(['in_review', 'approved'] as const)('退休 %s 时可新增、改期和预览，均不提前写任职', async (state) => {
    const x = await world(state);
    const retirement = await x.submittedRetire('2026-10-15');
    if (state === 'approved') await x.approve(retirement, '2026-10-06T02:00:00Z');
    const target = await draft(x);
    const patch = await x.session.request('PATCH', `/businesses/${target.id}`, {
      ifMatch: target.revision,
      body: { effectiveDate: '2026-10-19' },
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const before = await x.stateOf(x.employee.id);
    const preview = await x.session.request('POST', `/employees/${x.employee.id}/forward-update-preview`, {
      body: body('2026-10-19'),
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });

  it.each(['missing', 'draft', 'rejected', 'withdrawn', 'voided', 'same-day', 'later', 'other-employee'])(
    '不合格前置 %s：新增与预览精确拒绝且无业务写入',
    async (state) => {
      const x = await world(`negative-${state}`);
      if (state === 'draft') await x.createdRetire(x.employee.id, retireBody('2026-10-15'));
      else if (state === 'other-employee') {
        const other = await x.hired('合成另一员工');
        await x.submittedRetire('2026-10-15', other.employee.id);
      } else if (state !== 'missing') {
        const dates: Readonly<Record<string, string>> = { 'same-day': '2026-10-17', later: '2026-10-18' };
        const last = dates[state] ?? '2026-10-15';
        const retirement = await x.submittedRetire(last);
        if (state === 'rejected') await x.rejectInReview(retirement.id);
        if (state === 'voided') await cancel(x, retirement.id);
        if (state === 'withdrawn') {
          const response = await x.session.request('POST', `/businesses/${retirement.id}/withdraw`, {
            ifMatch: (await x.business(retirement.id)).revision,
            body: {},
          });
          expect(response.status).toBe(200);
        }
      }
      const before = await x.stateOf(x.employee.id);
      await refused(x, await create(x));
      await refused(
        x,
        await x.session.request('POST', `/employees/${x.employee.id}/forward-update-preview`, { body: body() }),
      );
      expect(await x.stateOf(x.employee.id)).toEqual(before);
    },
  );

  it('改期不得越过退休日；退休撤销后的旧草稿不能提交；直接方式始终严格', async () => {
    const x = await world('reschedule-direct');
    const retirement = await x.directRetire('2026-10-15');
    const target = await draft(x);
    const before = await x.stateOf(x.employee.id);
    await refused(
      x,
      await x.session.request('PATCH', `/businesses/${target.id}`, {
        ifMatch: target.revision,
        body: { effectiveDate: '2026-10-16' },
      }),
    );
    await refused(x, await create(x, undefined, 'direct'));
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    await cancel(x, retirement.id);
    const afterCancel = await x.stateOf(x.employee.id);
    await refused(
      x,
      await x.session.request('POST', `/businesses/${target.id}/submit`, {
        ifMatch: (await x.business(target.id)).revision,
        body: {},
      }),
    );
    expect(await x.stateOf(x.employee.id)).toEqual(afterCancel);
  });
});

describe('AC-RT-F314 DEC-677 挂起与自动续办', () => {
  it('到期挂起、HR 重试仍等待；迟到退休成功后顺延到次日，由现有调度自动生效', async () => {
    const x = await world('resume');
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await approved(x);
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [], suspended: [target.id] });
    await suspended(x, target.id, retirement.id);
    await x.runScheduler('2026-10-18T01:30:00Z');
    expect(await x.attempts(target.id)).toHaveLength(1);
    expect((await x.retry(target, '2026-10-18T02:00:00Z')).status).toBe(200);
    await suspended(x, target.id, retirement.id);
    await x.approve(retirement, '2026-10-20T02:00:00Z');
    expect((await x.business(retirement.id)).status).toBe('effective');
    expect((await x.business(target.id)).status).toBe('approved');
    expect((await x.versions(target.id)).at(-1)).toMatchObject({ effective_date: '2026-10-21', planned: '2026-10-18' });
    expect(await x.audits(target.id, 'employment.retire_rehire.rescheduled')).toEqual([
      expect.objectContaining({
        before: { effectiveDate: '2026-10-18' },
        after: expect.objectContaining({
          effectiveDate: '2026-10-21',
          retirementBusinessId: retirement.id,
          reason: 'RETIRE_REHIRE_AFTER_RETIREMENT',
        }),
      }),
    ]);
    expect(await x.runScheduler('2026-10-20T03:00:00Z')).toMatchObject({ activated: [], failed: [] });
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [target.id], failed: [] });
    expect((await x.timeline()).map((row) => [row.kind, row.start_date]).slice(-2)).toEqual([
      ['retirement', '2026-10-20'],
      ['retire_rehire', '2026-10-21'],
    ]);
    expect((await x.todos()).some((item) => item.id === target.id)).toBe(false);
    await x.runScheduler('2026-10-22T01:00:00Z');
    expect(await x.audits(target.id, 'employment.retire_rehire.rescheduled')).toHaveLength(1);
  });

  it('原返聘日晚于退休日加一天：保留原日，不写顺延审计', async () => {
    const x = await world('keep-date');
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await approved(x, '2026-10-22');
    await x.approve(retirement, '2026-10-20T02:00:00Z');
    expect((await x.business(retirement.id)).status).toBe('effective');
    expect((await x.business(target.id)).status).toBe('approved');
    expect(await x.runScheduler('2026-10-22T01:00:00Z')).toMatchObject({ activated: [target.id], failed: [] });
    expect((await x.timeline()).at(-1)).toMatchObject({ kind: 'retire_rehire', start_date: '2026-10-22' });
    expect(await x.audits(target.id, 'employment.retire_rehire.rescheduled')).toEqual([]);
  });

  it('前序退休失败也等待该退休，退休重试成功后自动续办', async () => {
    const x = await world('predecessor-failed');
    const retirement = await x.directRetire('2026-10-15');
    const target = await approved(x);
    const blocker = await x.transferIn('draft', '2026-10-17');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({
      failed: [retirement.id],
      suspended: [target.id],
    });
    await suspended(x, target.id, retirement.id);
    expect((await x.retry(target, '2026-10-18T02:00:00Z')).status).toBe(200);
    await suspended(x, target.id, retirement.id);
    const deleted = await x.session.request('DELETE', `/businesses/${blocker.id}`, {
      ifMatch: (await x.business(blocker.id)).revision,
    });
    expect(deleted.status).toBe(200);
    expect((await x.retry(retirement, '2026-10-20T03:00:00Z')).status).toBe(200);
    expect((await x.business(target.id)).status).toBe('approved');
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [target.id] });
  });

  it('返聘迟到审批通过时退休未生效：审批成功并挂起，口径与定时及 HR 重试一致', async () => {
    const x = await world('late-approval');
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await draft(x);
    await submit(x, target);
    expect((await x.approve(target, '2026-10-18T02:00:00Z')).status).toBe('approved');
    await suspended(x, target.id, retirement.id);
    expect(await x.attempts(target.id)).toHaveLength(1);
  });

  it('退休先迟到生效、返聘后批准：同样顺延到退休次日，保留人工计划日', async () => {
    const x = await world('retired-before-approval');
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await draft(x);
    await submit(x, target);
    await x.approve(retirement, '2026-10-20T02:00:00Z');
    expect((await x.business(target.id)).status).toBe('in_review');
    expect((await x.approve(target, '2026-10-22T02:00:00Z')).status).toBe('effective');
    expect((await x.timeline()).at(-1)).toMatchObject({ kind: 'retire_rehire', start_date: '2026-10-21' });
    expect((await x.versions(target.id)).at(-1)).toMatchObject({ effective_date: '2026-10-21', planned: '2026-10-18' });
    expect(await x.audits(target.id, 'employment.retire_rehire.rescheduled')).toHaveLength(1);
  });

  it.each(['cancel', 'reject', 'cancel-approved'] as const)(
    '尚未到期时退休 %s：不级联作废返聘，到期精确失败并进 HR 待办',
    async (action) => {
      const x = await world(`retire-${action}`);
      const retirement =
        action === 'cancel-approved' ? await x.directRetire('2026-10-15') : await x.submittedRetire('2026-10-15');
      const target = await approved(x);
      if (action === 'reject') await x.rejectInReview(retirement.id);
      else await cancel(x, retirement.id);
      expect((await x.business(target.id)).status).toBe('approved');
      expect(await x.attempts(target.id)).toEqual([]);
      expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [target.id], suspended: [] });
      await failed(x, target.id);
    },
  );

  it.each(['cancel', 'reject'] as const)('挂起中退休 %s：立即转失败，关联新退休不自动冒领旧返聘', async (action) => {
    const x = await world(`void-suspended-${action}`);
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await approved(x);
    await x.runScheduler('2026-10-18T01:00:00Z');
    await suspended(x, target.id, retirement.id);
    if (action === 'reject') await x.rejectInReview(retirement.id);
    else await cancel(x, retirement.id);
    await failed(x, target.id);
    expect((await x.attempts(target.id)).at(-1)).toMatchObject({
      outcome: 'failed',
      reason: VOIDED,
      detail: expect.objectContaining({ message: '关联退休已作废' }),
    });
    expect((await x.audits(target.id, 'employment.activation.failed')).at(-1)?.after).toMatchObject({
      trigger: 'retirement_change',
      reason: VOIDED,
    });
    if (action === 'cancel') await x.submittedRetire('2026-10-16');
    await x.runScheduler('2026-10-19T01:00:00Z');
    await failed(x, target.id);
    expect((await x.attempts(target.id)).filter((row) => row.outcome === 'failed')).toHaveLength(1);
  });

  it('HR 对关联退休作废的失败显式重试：记录本次失败尝试，不被挂起去重吞掉', async () => {
    const x = await world('voided-retry');
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await approved(x);
    await cancel(x, retirement.id);
    await x.runScheduler('2026-10-18T01:00:00Z');
    const response = await x.retry(target, '2026-10-19T01:00:00Z');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activation: { status: 'failed', failureReason: VOIDED, failureCount: 2 },
    });
    expect((await x.attempts(target.id)).map((row) => row.reason)).toEqual([VOIDED, VOIDED]);
  });

  it('退休预览和生效共用保留规则：保留后续返聘，其他申请仍作废', async () => {
    const x = await world('void-candidates');
    const retirement = await x.directRetire('2026-10-15');
    const target = await approved(x);
    const other = await x.transferIn('draft', '2026-10-19');
    const response = await x.session.request('POST', `/retirements/employees/${x.employee.id}/preview`, {
      body: { lastWorkDate: '2026-10-15' },
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { warnings: { reason: string; items: { businessId: string }[] }[] };
    const voided = preview.warnings.find((row) => row.reason === 'EXIT_APPLICATIONS_TO_VOID')!.items;
    expect(voided.map((item) => item.businessId)).toEqual([other.id]);
    expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [retirement.id] });
    expect((await x.business(target.id)).status).toBe('approved');
    expect((await x.business(other.id)).status).toBe('voided');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [target.id] });
  });

  it('同时返聘将开新周期：更后的另一份返聘仍作废，不误保留', async () => {
    const x = withRehire(database().db, await world('integrated'));
    const retirement = await x.createdRehire(x.rehireBody('2026-10-15'));
    const target = await approved(x);
    expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [retirement.id] });
    expect((await x.business(target.id)).status).toBe('voided');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement', 'retire_rehire']);
    expect(await x.rehireEffects(retirement.id)).toHaveLength(1);
  });

  it('在 SQL 限量前剔除保留项：1001 份后续返聘不会掩盖其他待作废申请', async () => {
    const x = await world('keep-before-limit');
    await x.directRetire('2026-10-15');
    // 大量同类候选只测候选上限，不伪造生效结果；夹具在 withTenant 内追加合成申请。
    await x.bulkDrafts(1001, x.employee.id, { kind: 'retire_rehire', state: 'draft', effectiveDate: '2026-10-18' });
    const other = await x.transferIn('draft', '2026-10-19');
    const response = await x.session.request('POST', `/retirements/employees/${x.employee.id}/preview`, {
      body: { lastWorkDate: '2026-10-15' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const preview = (await response.json()) as { warnings: { reason: string; items?: { businessId: string }[] }[] };
    expect(preview.warnings.some((item) => item.reason === 'EXIT_APPLICATIONS_TOO_MANY')).toBe(false);
    expect(preview.warnings.find((item) => item.reason === 'EXIT_APPLICATIONS_TO_VOID')!.items).toEqual([
      expect.objectContaining({ businessId: other.id }),
    ]);
  });
});
