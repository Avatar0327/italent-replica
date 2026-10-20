/**
 * R2 BE-5c2（R2-T04 §9.2，AC-RT-17-daily-pg，真 PG）：
 * - 两个进程同时认领当天批次，只有一个持有租约；
 * - 每日批次与立即执行同时跑：同一员工同日至多一次写入；
 * - HR 手改并核准同一员工（持员工锁）时，批次 SKIP LOCKED 跳过、第二遍仍忙则放弃，核准写入后不被覆盖。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runRetirementBatches } from '../../apps/api/src/modules/employment/retirement-scheduler.js';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { batchWorld, clockAt, type BatchWorld } from './AC-RT-batch-support.js';

const testDb = useTestDb();
const DAY = '2026-10-01';

const runBatch = (w: BatchWorld, clock = clockAt(DAY)) =>
  runRetirementBatches(
    w.db,
    { actorUserId: null, commandId: `rt-pg-${randomUUID()}` },
    { tenantId: w.tenantId },
    { clock: () => clock },
  );
const expectedRun = (result: Awaited<ReturnType<typeof runBatch>>) =>
  result.runs[0]!.purposes.find((item) => item.purpose === 'expected_date')!;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-17-daily-pg 每日批次并发（真 PG）', () => {
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
});
