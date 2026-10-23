/** DEC-675 / F-314：提前申请返聘，落地仍须已退休；真实接口造单，普通 PG 角色同样运行。 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import { retireBody, retirementWorld, type RetirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const world = (label: string) => retirementWorld(database().db, `f314-${label}`);
const REQUIRED = 'RETIRE_REHIRE_REQUIRES_RETIREMENT';
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
  expect(await x.reason(response)).toMatchObject({ status: 409, code: 'CONFLICT', reason: REQUIRED });
}
async function failed(x: RetirementWorld, id: string) {
  expect((await x.business(id)).activation).toMatchObject({ status: 'failed', failureReason: REQUIRED });
  expect((await x.todos()).find((item) => item.id === id)?.activation).toMatchObject({
    status: 'failed',
    failureReason: REQUIRED,
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
        const last = state === 'same-day' ? '2026-10-17' : state === 'later' ? '2026-10-18' : '2026-10-15';
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

describe('AC-RT-F314 生效失败与恢复', () => {
  it('退休仍审批中：到期失败、定时不盲重试；退休生效不作废返聘，HR 重试成功', async () => {
    const x = await world('retry');
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await approved(x);
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [target.id], suspended: [] });
    await failed(x, target.id);
    await x.runScheduler('2026-10-18T01:30:00Z');
    expect(await x.attempts(target.id)).toHaveLength(1);
    await x.approve(retirement, '2026-10-18T02:00:00Z');
    expect((await x.business(target.id)).status).toBe('approved');
    const retried = await x.retry(target, '2026-10-18T03:00:00Z');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement', 'retire_rehire']);
    expect((await x.attempts(target.id)).map((row) => row.outcome)).toEqual(['failed', 'effective']);
    expect((await x.todos()).some((item) => item.id === target.id)).toBe(false);
  });

  it('前序退休失败时返聘仍记精确失败，HR 重试不改记通用挂起', async () => {
    const x = await world('predecessor-failed');
    const retirement = await x.directRetire('2026-10-15');
    const target = await approved(x);
    const blocker = await x.transferIn('draft', '2026-10-17');
    const run = await x.runScheduler('2026-10-18T01:00:00Z');
    expect(run.failed).toEqual([retirement.id, target.id]);
    expect(run.suspended).toEqual([]);
    await failed(x, target.id);
    const retry = await x.retry(target, '2026-10-18T02:00:00Z');
    expect(retry.status, await retry.clone().text()).toBe(200);
    await failed(x, target.id);
    expect((await x.attempts(target.id)).map((row) => row.reason)).toEqual([REQUIRED, REQUIRED]);
    const deleted = await x.session.request('DELETE', `/businesses/${blocker.id}`, {
      ifMatch: (await x.business(blocker.id)).revision,
    });
    expect(deleted.status).toBe(200);
    expect((await x.retry(retirement, '2026-10-18T03:00:00Z')).status).toBe(200);
    expect((await x.business(target.id)).status).toBe('approved');
    expect((await x.retry(target, '2026-10-18T04:00:00Z')).status).toBe(200);
    expect((await x.business(target.id)).status).toBe('effective');
  });

  it('返聘迟到审批通过时退休未生效：审批成功，独立记生效失败', async () => {
    const x = await world('late-approval');
    await x.submittedRetire('2026-10-15');
    const target = await draft(x);
    await submit(x, target);
    const result = await x.approve(target, '2026-10-18T02:00:00Z');
    expect(result.status).toBe('approved');
    await failed(x, target.id);
    expect(await x.attempts(target.id)).toHaveLength(1);
  });

  it.each(['cancel', 'reject'] as const)('退休 %s 不联动作废已发起返聘，返聘到期失败', async (action) => {
    const x = await world(`retire-${action}`);
    const retirement = await x.submittedRetire('2026-10-15');
    const target = await approved(x);
    if (action === 'cancel') await cancel(x, retirement.id);
    else await x.rejectInReview(retirement.id);
    expect((await x.business(target.id)).status).toBe('approved');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ failed: [target.id] });
    await failed(x, target.id);
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
    const preview = (await response.json()) as { warnings: { reason: string; items: { id: string }[] }[] };
    const voided = preview.warnings.find((row) => row.reason === 'EXIT_APPLICATIONS_TO_VOID')!.items;
    expect(voided.map((item) => item.id)).toEqual([other.id]);
    expect(await x.runScheduler('2026-10-16T01:00:00Z')).toMatchObject({ activated: [retirement.id] });
    expect((await x.business(target.id)).status).toBe('approved');
    expect((await x.business(other.id)).status).toBe('voided');
    expect(await x.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [target.id] });
  });
});
