/**
 * F-238（#423 BE-15b2 第 2 轮 P3-1）：每日批次待续跑里“员工主档不存在”的孤儿 pending 要收口，不能当作“被他人持锁”无限重试
 * （docs/02_业务建模/29 PB-R17，AC-PB-06；DEC-539①、DEC-052）。主档不存在 → 清掉 pending、不发起、不计 skippedLocked，
 * 当天批次正常标记完成；真被锁的员工仍留在 pending 续跑，行为不变。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { autoAssessmentWorld, rowsOf, type AutoAssessmentWorld } from './AC-PB-BE15b2-support.js';

const testDb = useTestDb();
const DAY = '2026-10-01T01:00:00.000Z';
const BUSINESS_DATE = '2026-10-01';

/** 夹具：当天已扫描过一遍（swept）但未完成，并为 employeeId 写一条待续跑——等价于“扫描后该员工的主档被清掉”。 */
async function seedSweptDay(w: AutoAssessmentWorld, pending: { employeeId: string; reason: 'locked' | 'error' }[]) {
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO employment_auto_assessment_daily_runs(tenant_id, business_date, command_id, swept)
      VALUES (${w.tenant.id}, ${BUSINESS_DATE}::date, ${randomUUID()}, true)`);
    for (const item of pending)
      await tx.execute(sql`INSERT INTO employment_auto_assessment_daily_pending(tenant_id, business_date, employee_id,
          reason, attempts) VALUES (${w.tenant.id}, ${BUSINESS_DATE}::date, ${item.employeeId}::uuid, ${item.reason}, 1)`);
  });
}

const pendingOf = (w: AutoAssessmentWorld) =>
  w.asTenant(async (tx) =>
    rowsOf<{ employeeId: string; attempts: number }>(
      await tx.execute(sql`SELECT employee_id::text AS "employeeId", attempts FROM employment_auto_assessment_daily_pending
        WHERE tenant_id=${w.tenant.id} AND business_date=${BUSINESS_DATE}::date ORDER BY employee_id`),
    ),
  );

const completedOf = (w: AutoAssessmentWorld) =>
  w.asTenant(async (tx) => {
    const [row] = rowsOf<{ completed: boolean }>(
      await tx.execute(sql`SELECT completed_at IS NOT NULL AS completed FROM employment_auto_assessment_daily_runs
        WHERE tenant_id=${w.tenant.id} AND business_date=${BUSINESS_DATE}::date`),
    );
    return row!.completed;
  });

describe('孤儿 pending 收口（主档不存在 ≠ 被锁）', () => {
  it('主档不存在的 pending：一次调度清掉、不计 skippedLocked、不发起，当天批次标记完成，再调度不重跑', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'orphan');
    await w.created(w.body());
    await w.enableSwitch();
    const orphan = randomUUID();
    await seedSweptDay(w, [{ employeeId: orphan, reason: 'locked' }]);

    const run = await w.batch(DAY);
    expect(run).toMatchObject({ ran: true, skippedLocked: 0, launched: [], failed: [], errors: [] });
    expect(await pendingOf(w)).toEqual([]);
    expect(await completedOf(w)).toBe(true);
    expect(await w.batch(DAY)).toMatchObject({ ran: false });
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('孤儿与真锁并存（真 PG）', () => {
  it('两连接：持锁员工仍留在 pending 续跑、孤儿被清掉，当天不算完成；释放后发起一次并完成', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'orphan-and-locked');
    await w.created(w.body());
    const person = await w.probationer('被锁员工');
    await w.enableSwitch();
    const orphan = randomUUID();
    await seedSweptDay(w, [
      { employeeId: person.employeeId, reason: 'locked' },
      { employeeId: orphan, reason: 'locked' },
    ]);

    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((done) => (locked = done));
    const gate = new Promise<void>((done) => (release = done));
    const holder = withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees
        WHERE tenant_id=${w.tenant.id} AND id=${person.employeeId}::uuid FOR UPDATE`);
      locked();
      await gate;
    });
    await holding;
    try {
      const first = await w.batch(DAY);
      // 只有真被锁的人计入 skippedLocked；孤儿不计
      expect(first).toMatchObject({ ran: true, skippedLocked: 1, launched: [], failed: [], errors: [] });
      expect((await pendingOf(w)).map((row) => row.employeeId)).toEqual([person.employeeId]);
      expect(await completedOf(w)).toBe(false);
    } finally {
      release();
      await holder;
    }

    const second = await w.batch(DAY);
    expect(second).toMatchObject({ ran: true, skippedLocked: 0, errors: [], failed: [] });
    expect(second.launched.map((item) => item.employeeId)).toEqual([person.employeeId]);
    expect(await pendingOf(w)).toEqual([]);
    expect(await completedOf(w)).toBe(true);
    expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
  });
});
