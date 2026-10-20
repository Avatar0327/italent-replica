/**
 * R2 BE-5c2（R2-T04 §9.2，AC-RT-17-daily-pg，真 PG）：
 * - 两个进程同时认领当天批次，只有一个持有租约；
 * - 每日批次与立即执行同时跑：同一员工同日至多一次写入；
 * - HR 手改并核准同一员工（持员工锁）时，批次 SKIP LOCKED 跳过、第二遍仍忙则放弃，核准写入后不被覆盖。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rulesModule from '../../apps/api/src/modules/employment/retirement-rules.js';
import * as locks from '../../apps/api/src/modules/employment/transfer-locks.js';
import { runRetirementBatches } from '../../apps/api/src/modules/employment/retirement-scheduler.js';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { batchWorld, clockAt, rows, type BatchWorld } from './AC-RT-batch-support.js';
import { batchBarriers, takeoverWaitsForOwner } from './support/retirement-batch-barrier.js';

const testDb = useTestDb();
const DAY = '2026-10-01';
const barriers = batchBarriers();

const runBatch = (w: BatchWorld, clock = clockAt(DAY)) =>
  runRetirementBatches(
    w.db,
    { actorUserId: null, commandId: `rt-pg-${randomUUID()}` },
    { tenantId: w.tenantId },
    { clock: () => clock },
  );
const expectedRun = (result: Awaited<ReturnType<typeof runBatch>>) =>
  result.runs[0]!.purposes.find((item) => item.purpose === 'expected_date')!;

/**
 * 屏障：第一次按指定用途加载规则的调用（持有批次的进程 A）在规则加载完成后暂停，其余调用（B）直接通过。
 * 返回 reached（A 已暂停）与 proceed（放行 A）。
 */
function pauseFirstRuleLoad(purpose: 'expected_date' | 'flexible_range') {
  let reached!: () => void;
  let proceed!: () => void;
  const reachedSignal = new Promise<void>((resolve) => (reached = resolve));
  const proceedSignal = new Promise<void>((resolve) => (proceed = resolve));
  const load = rulesModule.loadRetirementRulesForRun;
  let paused = false;
  vi.spyOn(rulesModule, 'loadRetirementRulesForRun').mockImplementation(async (...args) => {
    const loaded = await load(...args);
    if (args[2] === purpose && !paused) {
      paused = true;
      reached();
      await proceedSignal;
    }
    return loaded;
  });
  return { reached: reachedSignal, proceed };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-17-daily-pg 每日批次并发（真 PG）', () => {
  afterEach(async () => {
    try {
      await barriers.close();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    ['主扫描', 'main'],
    ['第二遍写入', 'retry-write'],
    ['第二遍仍忙', 'retry-busy'],
  ] as const)('AC-RT-17 校验后屏障：%s事务提交前，租约接管必须等待所有权共享锁', async (_label, phase) => {
    const w = await batchWorld(testDb().db, `rt17pg-owner-${phase}`);
    const employee = await w.member('所有权屏障合成员工');
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const base = await w.personOf(employee);
    const gate = barriers.gate();
    const original = locks.lockTransferParticipants;
    let calls = 0;
    let ownerPid = 0;
    vi.spyOn(locks, 'lockTransferParticipants').mockImplementation(async (...args) => {
      calls += 1;
      if (phase !== 'main' && calls === 1) return 'busy';
      if (calls === (phase === 'main' ? 1 : 2)) {
        // asBatchOwner 已完成 running/attempts 校验及 FOR SHARE；同一员工事务尚未提交（设计 §9.2）。
        ownerPid = rows<{ pid: number }>(await args[0].execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid;
        gate.reach();
        await gate.proceed;
        if (phase === 'retry-busy') return 'busy';
      }
      return original(...args);
    });

    const owner = barriers.track(runBatch(w));
    try {
      await gate.waitFor(owner);
      expect(ownerPid).toBeGreaterThan(0);
      expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'running', attempts: 1 });
      expect(await w.personOf(employee)).toEqual(base);
      if (phase !== 'main')
        expect(await w.skipRows('expected_date', DAY)).toEqual([{ employeeId: employee, state: 'pending' }]);

      const taker = barriers.track(runBatch(w, clockAt(DAY, '02:11:00')));
      expect(
        await takeoverWaitsForOwner(w.db, ownerPid, taker),
        '接管 UPDATE 必须等待已通过所有权校验的员工事务提交',
      ).toBe(true);
      gate.release();
      const results = await Promise.all([owner, taker]);
      for (const result of results)
        for (const run of result.runs[0]!.purposes)
          expect(run).toMatchObject({ aborted: false, abortReason: null, failed: [] });
      expect(await w.runRow('expected_date', DAY)).toMatchObject({
        state: 'done',
        skipped: phase === 'retry-busy' ? 1 : 0,
      });
      expect(await w.skipRows('expected_date', DAY)).toEqual(
        phase === 'retry-busy' ? [{ employeeId: employee, state: 'given_up' }] : [],
      );
      expect(await w.personOf(employee)).toMatchObject({
        revision: base.revision + (phase === 'retry-busy' ? 0 : 1),
        expected: phase === 'retry-busy' ? base.expected : '2035-06-30',
      });
    } finally {
      gate.release();
    }
  });

  it('两个进程同时认领当天批次：只有一个持有租约，每名员工只写一次', async () => {
    const w = await batchWorld(testDb().db, 'rt17pg-claim');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await w.member(`并发认领${i}`));
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const before = await Promise.all(ids.map((id) => w.personOf(id)));

    const results = await Promise.all([runBatch(w), runBatch(w)]);
    expect(results.filter((result) => expectedRun(result).ran)).toHaveLength(1);
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'done', attempts: 1 });
    const after = await Promise.all(ids.map((id) => w.personOf(id)));
    expect(after.map((row) => row.revision)).toEqual(before.map((row) => row.revision + 1));
  });

  it('每日批次与立即执行同时运行：同一员工同日至多一次写入', async () => {
    const w = await batchWorld(testDb().db, 'rt17pg-race');
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await w.member(`并发写入${i}`));
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const before = await Promise.all(ids.map((id) => w.personOf(id)));

    const now = () =>
      w.session.request('POST', '/retirement-rules/run?purpose=expected_date', { ifMatch: 0, body: {} });
    const [first, second] = await Promise.all([now(), now(), runBatch(w)]);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.status, await second.clone().text()).toBe(200);
    const after = await Promise.all(ids.map((id) => w.personOf(id)));
    expect(after.map((row) => row.revision)).toEqual(before.map((row) => row.revision + 1));
    for (const row of after) expect(row.expected).toBe('2035-06-30');
  });

  it('HR 手改并核准同一员工（持员工锁）：批次跳过并在第二遍放弃，核准写入后不被覆盖', async () => {
    const w = await batchWorld(testDb().db, 'rt17pg-hr');
    const employee = await w.member('HR 手改员工');
    const other = await w.member('其他员工');
    await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);

    let locked!: () => void;
    let release!: () => void;
    const lockedSignal = new Promise<void>((resolve) => (locked = resolve));
    const releaseSignal = new Promise<void>((resolve) => (release = resolve));
    const hr = withTenant(w.db, w.tenantId, async (tx) => {
      await appendEmployee(
        tx,
        {
          tenantId: w.tenantId,
          userId: w.userId,
          timezone: w.session.tenant.timezone,
          now: clockAt(DAY),
          commandId: randomUUID(),
          expectedRevision: 0,
        } as never,
        employee,
        { expectedRetirementDate: '2031-01-31', expectedRetirementConfirmed: true },
        false,
      );
      locked();
      await releaseSignal;
    });
    await lockedSignal;

    const result = await runBatch(w);
    const run = expectedRun(result);
    expect(run.updated.map((item) => item.employeeId)).toEqual([other]);
    expect(run.givenUp).toBe(1);
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'done', skipped: 1 });
    release();
    await hr;

    expect(await w.personOf(employee)).toMatchObject({ expected: '2031-01-31', confirmed: true });
    // 次日批次照常覆盖：员工已核准，仍不改写
    await runBatch(w, clockAt('2026-10-02'));
    expect(await w.personOf(employee)).toMatchObject({ expected: '2031-01-31', confirmed: true });
  });

  it('租约被接管后旧进程不能提交人事版本（第 1 轮 P2-1）：A 加载规则后暂停，租约过期、改规则、B 接管写入并 done，恢复 A', async () => {
    const w = await batchWorld(testDb().db, 'rt17pg-takeover');
    const employee = await w.member('接管员工');
    const rule = await w.fixedAgeRule(60);
    await w.setSwitch('expected_date', true);
    const base = await w.personOf(employee);
    const barrier = pauseFirstRuleLoad('expected_date');

    const stale = runBatch(w, clockAt(DAY));
    await barrier.reached;
    const changed = await w.session.request('PUT', `/retirement-rules/${rule.id}`, {
      ifMatch: rule.revision,
      body: {
        purpose: 'expected_date',
        name: '固定年龄-61',
        priority: 1,
        orgIds: [w.org.id],
        retirementAgeYears: 61,
        retirementAgeMonths: 0,
        conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
      },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);

    const taker = await runBatch(w, clockAt(DAY, '02:11:00'));
    expect(expectedRun(taker)).toMatchObject({ ran: true, resumed: true });
    expect(await w.personOf(employee)).toMatchObject({ expected: '2036-06-30', revision: base.revision + 1 });

    barrier.proceed();
    expect(expectedRun(await stale).ran).toBe(false);
    // 旧进程的人事版本与审计整体回滚：P 与版本号都不被它改变
    expect(await w.personOf(employee)).toMatchObject({ expected: '2036-06-30', revision: base.revision + 1 });
    expect(await w.runRow('expected_date', DAY)).toMatchObject({ state: 'done', attempts: 2 });
  });

  it('弹性批次等预计日期批次 done（第 1 轮 P2-2）：A 处理预计日期中，B 不认领弹性；A 完成后弹性按新 P 写范围', async () => {
    const w = await batchWorld(testDb().db, 'rt17pg-order');
    const employee = await w.member('顺序员工', {
      expectedRetirementDate: '2030-06-01',
      expectedRetirementConfirmed: false,
      earliestRetirementDate: '2030-06-01',
      latestRetirementDate: '2033-06-01',
      flexibleRangeConfirmed: false,
    });
    await w.fixedAgeRule(60);
    await w.statutoryRangeRule();
    await w.setSwitch('expected_date', true);
    await w.setSwitch('flexible_range', true);
    const barrier = pauseFirstRuleLoad('expected_date');

    const first = runBatch(w, clockAt(DAY));
    await barrier.reached;
    const second = await runBatch(w, clockAt(DAY));
    expect(second.runs[0]!.purposes.map((item) => item.ran)).toEqual([false, false]);
    expect(await w.runRow('flexible_range', DAY)).toBeUndefined();

    barrier.proceed();
    const done = (await first).runs[0]!.purposes;
    expect(done.map((item) => item.ran)).toEqual([true, true]);
    expect(await w.personOf(employee)).toMatchObject({
      expected: '2035-06-30',
      earliest: '2035-06-11',
      latest: '2038-06-30',
    });
    expect(await w.runRow('flexible_range', DAY)).toMatchObject({ state: 'done' });
  });
});
