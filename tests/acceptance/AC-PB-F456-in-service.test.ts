/** DEC-788：转正申请按租户今天的在职试用主职判资格，日期非法为 400。 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  businessRevision,
  employeeRevision,
  hire,
  pbWorld,
  probationView,
  regularizeOk,
  type PbWorld,
} from './AC-PB-support.js';

const testDb = useTestDb();
const stateMessage = '员工非在职试用状态，不能发起转正申请';
const invalidDates = [
  ['2026-08-31', 'normal', '必须大于等于入职日期'],
  ['2026-09-01', 'normal', '转正日期必须大于试用期开始日期'],
  ['2026-11-30', 'early', '提前转正时，转正日期须早于预计试用结束日期'],
  ['2026-12-01', 'early', '提前转正时，转正日期须早于预计试用结束日期'],
  ['2026-11-30', 'delayed', '延期转正时，转正日期须晚于预计试用结束日期'],
  ['2026-11-29', 'delayed', '延期转正时，转正日期须晚于预计试用结束日期'],
] as const;

async function create(w: PbWorld, id: string, effectiveDate: string, probationResult = 'normal') {
  return w.session.request('POST', `/employees/${id}/businesses`, {
    ifMatch: await employeeRevision(w, id),
    body: { kind: 'regularization', mode: 'application', effectiveDate, probationResult },
  });
}

async function error(response: Response, status: number, message: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({
    error: { code: status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED', message },
  });
}

describe('AC-PB-F456 今天在职资格与入口', () => {
  it.each(['future', 'left', 'regular'] as const)('%s 员工不能用回溯 / 未来日期建申请或暂存', async (state) => {
    const w = await pbWorld(testDb().db, `f456-${state}`);
    const { employee } = await hire(w, {
      date: state === 'future' ? '2026-11-01' : '2026-09-01',
      probation: state !== 'regular',
      months: 3,
    });
    if (state === 'left')
      await w.session.business(
        employee.id,
        { kind: 'leave', mode: 'direct', effectiveDate: '2026-09-20' },
        await employeeRevision(w, employee.id),
      );
    const effectiveDate = state === 'future' ? '2026-11-15' : '2026-09-15';
    await error(await create(w, employee.id, effectiveDate), 409, stateMessage);
    await error(
      await w.session.request('PUT', `/employees/${employee.id}/regularization-draft`, {
        ifMatch: 0,
        body: { effectiveDate },
      }),
      409,
      stateMessage,
    );
    expect((await probationView(w, 'all')).some((row) => row.employeeId === employee.id)).toBe(false);
    const receipt = await regularizeOk(w, { mode: 'application', effectiveDate }, [employee.id]);
    expect(receipt.items[0]).toMatchObject({ status: 'failed', error: { code: 'CONFLICT', message: stateMessage } });
  });

  it('在职试用行给服务端资格；同一天离职后提交 / 改草稿都 409，未写入', async () => {
    const w = await pbWorld(testDb().db, 'f456-submit', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    expect((await probationView(w, 'all')).find((row) => row.employeeId === employee.id)).toMatchObject({
      canApplyRegularization: true,
    });
    const response = await create(w, employee.id, '2026-09-15');
    expect(response.status).toBe(201);
    const draft = (await response.json()) as { id: string; revision: number };
    await w.session.business(
      employee.id,
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-10-01' },
      await employeeRevision(w, employee.id),
    );
    for (const body of [{ effectiveDate: '2026-09-16' }, { probationResult: 'early' }]) {
      await error(
        await w.session.request('PATCH', `/businesses/${draft.id}`, { ifMatch: draft.revision, body }),
        409,
        stateMessage,
      );
    }
    await error(
      await w.session.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} }),
      409,
      stateMessage,
    );
    expect(await businessRevision(w, draft.id)).toBe(draft.revision);
  });

  it('今天入职与租户日界线：入职当天可申请，前一租户日期仍为 409', async () => {
    const w = await pbWorld(testDb().db, 'f456-today');
    const { employee } = await hire(w, { date: '2026-10-01', months: 3 });
    w.session.setNow('2026-09-30T15:59:59Z');
    await error(await create(w, employee.id, '2026-11-01'), 409, stateMessage);
    w.session.setNow('2026-09-30T16:00:00Z');
    expect((await create(w, employee.id, '2026-11-01')).status).toBe(201);
  });

  it('不存在沿用 404；不把不存在改成资格 409', async () => {
    const w = await pbWorld(testDb().db, 'f456-missing');
    const response = await w.session.request('POST', `/employees/${randomUUID()}/businesses`, {
      ifMatch: 0,
      body: { kind: 'regularization', mode: 'application', effectiveDate: '2026-11-01', probationResult: 'normal' },
    });
    expect(response.status).toBe(404);
  });
});

describe('AC-PB-F456 四条日期校验及边界', () => {
  it.each(invalidDates)('建单 %s / %s → 400 原站文案', async (date, result, message) => {
    const w = await pbWorld(testDb().db, `f456-date-${date}-${result}`);
    const { employee } = await hire(w, { months: 3 });
    await error(await create(w, employee.id, date, result), 400, message);
    await error(
      await w.session.request('PUT', `/employees/${employee.id}/regularization-draft`, {
        ifMatch: 0,
        body: { effectiveDate: date, probationResult: result },
      }),
      400,
      message,
    );
  });

  it.each([
    ['2026-11-29', 'early'],
    ['2026-11-30', 'normal'],
    ['2026-12-01', 'delayed'],
  ] as const)('合法 %s / %s 仍然 201', async (date, result) => {
    const w = await pbWorld(testDb().db, `f456-valid-${result}`);
    const { employee } = await hire(w, { months: 3 });
    expect((await create(w, employee.id, date, result)).status).toBe(201);
  });

  it('改结果按改后日期校验；日期与结果一起改可保存；提交重新核对当前试用信息', async () => {
    const w = await pbWorld(testDb().db, 'f456-edit', { approval: true });
    const { employee } = await hire(w, { months: 3 });
    const response = await create(w, employee.id, '2026-12-01');
    expect(response.status).toBe(201);
    const draft = (await response.json()) as { id: string; revision: number };
    await error(
      await w.session.request('PATCH', `/businesses/${draft.id}`, {
        ifMatch: draft.revision,
        body: { probationResult: 'early' },
      }),
      400,
      invalidDates[2][2],
    );
    const patched = await w.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { probationResult: 'early', effectiveDate: '2026-11-29' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const adjustment = await w.session.request('PUT', `/employees/${employee.id}/probation`, {
      ifMatch: await employeeRevision(w, employee.id),
      body: { hasProbation: true, startDate: '2026-09-01', expectedEndDate: '2026-11-28' },
    });
    expect(adjustment.status, await adjustment.clone().text()).toBe(200);
    await error(
      await w.session.request('POST', `/businesses/${draft.id}/submit`, {
        ifMatch: await businessRevision(w, draft.id),
        body: {},
      }),
      400,
      invalidDates[2][2],
    );
  });
});
