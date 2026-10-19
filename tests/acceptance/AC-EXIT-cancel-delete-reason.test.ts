/**
 * R2-T03 B4 第 4 轮返工：离职单的通用 DELETE 映射为 cancel，撤销原因必填（设计 §4 DELETE 行 +「cancel | Employment.DimissionCancel |
 * reason 必填」，§7.1 草稿 = process_voided）。缺原因一律 400 EXIT_CANCEL_REASON_REQUIRED，且无任何写入；带原因才执行并写撤销记录。
 * draft / approved / effective 三种状态各一例；权限与范围先于 body 校验（B-47），这里的账号有全部权限。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cancelWorld, type CancelWorld } from './AC-EXIT-cancel-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const STATES = ['draft', 'approved', 'effective'] as const;

async function leaveIn(x: CancelWorld, state: (typeof STATES)[number]) {
  if (state === 'approved') return x.directLeave('2026-10-20');
  if (state === 'effective') return x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
  return x.createdLeave(x.employee.id, leaveBody('2026-10-20', 'application'));
}

const cancellationCount = async (x: CancelWorld, businessId: string) =>
  (
    await x.sqlRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM exit_cancellations
      WHERE tenant_id=${x.session.tenant.id} AND business_id=${businessId}::uuid`)
  )[0]!.n;

describe('通用 DELETE 离职单：缺撤销原因 → 400，无写入', () => {
  it.each(STATES)('%s：不带 body → 400 EXIT_CANCEL_REASON_REQUIRED，状态 / revision / 撤销记录不变', async (state) => {
    const x = await cancelWorld(database().db, `r4-delete-no-reason-${state}`, TODAY);
    const leave = await leaveIn(x, state);
    const before = await x.business(leave.id);
    const stateBefore = await x.stateOfBusiness(leave.id);

    const response = await x.session.request('DELETE', `/businesses/${leave.id}`, { ifMatch: before.revision });

    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'EXIT_CANCEL_REASON_REQUIRED' });
    expect(await x.stateOfBusiness(leave.id)).toBe(stateBefore);
    expect((await x.business(leave.id)).revision).toBe(before.revision);
    expect(await cancellationCount(x, leave.id)).toBe(0);
  });

  it.each(STATES)('%s：原因只有空白 → 400，同样无写入', async (state) => {
    const x = await cancelWorld(database().db, `r4-delete-blank-reason-${state}`, TODAY);
    const leave = await leaveIn(x, state);
    const stateBefore = await x.stateOfBusiness(leave.id);

    const response = await x.session.request('DELETE', `/businesses/${leave.id}`, {
      ifMatch: leave.revision,
      body: { reason: '   ' },
    });

    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'EXIT_CANCEL_REASON_REQUIRED' });
    expect(await x.stateOfBusiness(leave.id)).toBe(stateBefore);
    expect(await cancellationCount(x, leave.id)).toBe(0);
  });

  it.each(STATES)('%s：对照——带原因 → 200，写一条撤销记录', async (state) => {
    const x = await cancelWorld(database().db, `r4-delete-with-reason-${state}`, TODAY);
    const leave = await leaveIn(x, state);

    const response = await x.session.request('DELETE', `/businesses/${leave.id}`, {
      ifMatch: leave.revision,
      body: { reason: '误录入' },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await cancellationCount(x, leave.id)).toBe(1);
    expect(await x.cancellationOf(leave.id)).toMatchObject({ reason: '误录入' });
  });
});
