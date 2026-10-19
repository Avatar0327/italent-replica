/**
 * R2 BE-8b1 真 PostgreSQL 并发（普通角色 app_owner）：离职生效写黑名单 与 黑名单页手动新增同一人。
 * 两条路径都经 addBlacklistEntry，在租户级咨询锁（:employment-blacklist）内先查重再写：恰好一行有效名单；
 * 后到的一方——生效侧得到 BLACKLIST_DUPLICATE 被跳过并在审计留痕（离职不回滚），页面侧得到 409。
 * 交错用 pg_stat_activity 的锁等待屏障（waitForBlocked）强制，不靠 Promise.all 碰运气。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as blacklist from '../../apps/api/src/modules/employment/blacklist.js';
import { blacklistExitWorld, FUTURE_EFFECTIVE_DATE, FUTURE_LAST_WORK_DATE } from './AC-EXIT-blacklist-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const world = (label: string) => blacklistExitWorld(database().db, label);
const MANUAL = { addToBlacklist: true, blacklistReason: 'integrity' };

/** 满足 pauseWhen 的那次 addBlacklistEntry 写完行后暂停（此时持有名单锁、事务未提交），其余调用直接放行。 */
function pauseAfterInsert(pauseWhen: (input: { reason: string }) => boolean) {
  let entered!: () => void;
  let resume!: () => void;
  const enteredOnce = new Promise<void>((done) => (entered = done));
  const released = new Promise<void>((done) => (resume = done));
  const original = blacklist.addBlacklistEntry;
  vi.spyOn(blacklist, 'addBlacklistEntry').mockImplementation(async (tx, ctx, input, options) => {
    const entry = await original(tx, ctx, input, options);
    if (pauseWhen(input)) {
      entered();
      await released;
    }
    return entry;
  });
  return { enteredOnce, resume };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-EXIT-blacklist-pg 离职生效写名单 vs 黑名单页新增', () => {
  afterEach(() => vi.restoreAllMocks());

  it('黑名单页先得锁：生效在名单锁上等待，放行后发现已有有效记录而跳过并留痕，离职照常生效，恰一行有效名单', async () => {
    const x = await world('pg-page-first');
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, MANUAL);
    const gate = pauseAfterInsert((input) => input.reason === 'resignation');
    const adding = x.page.add({ employeeId: x.employee.id, reason: 'resignation' });
    await gate.enteredOnce;
    const activating = x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    await waitForBlocked(x.db, 1);
    gate.resume();
    const [added, activated] = await Promise.all([adding, activating]);
    expect(added.status, await added.clone().text()).toBe(201);
    expect(activated).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');
    const active = await x.activeRows(x.employee.id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ reason: 'resignation', exitRequestId: null });
    expect(await x.auditActions(leave.id, 'exit.blacklist.skipped')).toHaveLength(1);
  });

  it('生效先得锁：黑名单页在名单锁上等待，放行后得到 409 BLACKLIST_DUPLICATE，恰一行有效名单（记下离职请求 ID）', async () => {
    const x = await world('pg-exit-first');
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, MANUAL);
    const gate = pauseAfterInsert((input) => input.reason === 'integrity');
    const activating = x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    await gate.enteredOnce;
    const adding = x.page.add({ employeeId: x.employee.id, reason: 'resignation' });
    await waitForBlocked(x.db, 1);
    gate.resume();
    const [activated, added] = await Promise.all([activating, adding]);
    expect(activated).toMatchObject({ outcome: 'effective' });
    expect(await x.reasonOf(added)).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'BLACKLIST_DUPLICATE' });
    const active = await x.activeRows(x.employee.id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ source: 'manual', reason: 'integrity', exitRequestId: leave.id });
    expect(await x.auditActions(leave.id, 'exit.blacklist.skipped')).toHaveLength(0);
  });
});
