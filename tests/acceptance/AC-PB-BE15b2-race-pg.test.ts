/**
 * BE-15b2 自动考核与手工入口的真 PG 并发（AC-PB-06，PB-R9 / R20）：每日批次与手工发起考核 / 手工直接转正同时进行，
 * 对同一员工结果只能二选一——要么自动考核发起、手工入口被互斥拦下，要么手工先办、自动考核按 PB-R20 失败——
 * 不会出现两条在途考核、也不会出现“考核审批中又有转正”。立即执行与每日批次同时运行同样只发起一次。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { autoAssessmentWorld, rowsOf } from './AC-PB-BE15b2-support.js';

const testDb = useTestDb();
const BATCH = '2026-10-01T01:00:00.000Z';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('自动考核并发不重复（真 PG）', () => {
  it('两次立即执行 + 每日批次同时运行：每名到期员工只有一条自动考核、一条发起台账', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'race-auto');
    await w.created(w.body());
    const people = [];
    for (let i = 0; i < 4; i += 1) people.push(await w.probationer(`并发员工${i}`));
    await w.enableSwitch();
    const [first, second, scheduled] = await Promise.all([w.runNow(), w.runNow(), w.batch(BATCH)]);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.status, await second.clone().text()).toBe(200);
    const launched =
      ((await first.json()) as { launched: unknown[] }).launched.length +
      ((await second.json()) as { launched: unknown[] }).launched.length +
      scheduled.launched.length;
    expect(launched).toBe(people.length);
    for (const person of people) {
      expect(await w.assessmentsOf(person.employeeId)).toHaveLength(1);
      expect((await w.launchesOf(person.employeeId)).filter((row) => row.state === 'launched')).toHaveLength(1);
    }
  });

  it('每日批次与手工发起考核同时：同一员工只有一条在途考核（自动发起则手工被 PB-R9 拦下；手工先办则自动按 PB-R20 失败）', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'race-manual');
    await w.created(w.body());
    const person = await w.probationer('手工并发员工');
    await w.enableSwitch();
    const [batch, manual] = await Promise.all([w.batch(BATCH), w.launchRaw('probation', [person])]);
    expect(manual.status, await manual.clone().text()).toBe(200);
    const manualReceipt = (await manual.json()) as { items: { status: string }[] };
    const manualWon = manualReceipt.items[0]!.status === 'succeeded';
    const assessments = await w.assessmentsOf(person.employeeId);
    expect(assessments.filter((row) => row.status === 'in_review')).toHaveLength(1);
    expect(batch.errors).toEqual([]);
    if (manualWon) expect(batch.launched).toEqual([]);
    else expect(batch.launched).toHaveLength(1);
    expect(assessments[0]!.initiation).toBe(manualWon ? 'manual' : 'auto');
  });

  it('每日批次与手工直接转正同时：不会出现“转正已办又有在途考核”', async () => {
    const w = await autoAssessmentWorld(testDb().db, 'race-regularize');
    await w.created(w.body());
    const person = await w.probationer('转正并发员工');
    await w.enableSwitch();
    const [batch, manual] = await Promise.all([w.batch(BATCH), w.regularizeRaw(person, 'direct', '2026-10-01')]);
    const manualDone = manual.status === 200 && ((await manual.json()) as { succeeded: number }).succeeded === 1;
    const inReview = (await w.assessmentsOf(person.employeeId)).filter((row) => row.status === 'in_review');
    const regularizations = await w.asTenant(async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM employment_business_objects b
          JOIN LATERAL (SELECT kind FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
            AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
          WHERE b.tenant_id=${w.tenant.id} AND b.employee_id=${person.employeeId}::uuid AND p.kind='regularization'`),
      ),
    );
    // 二选一：转正已办（自动考核失败）或考核在途（转正被 PB-R9 拦下）
    expect(manualDone ? inReview.length : regularizations[0]!.n).toBe(0);
    expect(manualDone || inReview.length === 1).toBe(true);
    expect(batch.errors).toEqual([]);
  });
});
