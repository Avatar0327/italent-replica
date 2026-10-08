/**
 * R3-T07 PR-B 在真实 PostgreSQL 16 上的强制交错（AGENTS §10「并发」；取锁顺序：计划 → 审批实例）：
 * - HR 干预持有计划行锁（未提交）时运行调度：调度 SKIP LOCKED 跳过该计划、不重复开启；释放后同日再跑照常开启；
 * - 计划被终止的事务持锁（未提交）时员工新增目标：等待后在锁内重读，计划已终止 → 403，不写入目标。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type Approvals, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function blocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未观测到 ${expected} 个被锁阻塞的并发操作`);
}

const scheduled = (a: Approvals) => [
  {
    name: '制定计划',
    category: 'plan',
    approvalType: 'idp_plan',
    approvalProcessId: a.plan,
    startMode: 'auto',
    startTimeType: 'relative',
    referencePoint: 'plan_start',
    startFrom: 'same_day',
  },
  {
    name: '中期回顾',
    category: 'review',
    approvalType: 'idp_mid_review',
    approvalProcessId: a.mid,
    startMode: 'manual',
  },
];

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('R3-T07 IDP 计划执行 PostgreSQL 16 强制交错', () => {
  it('计划被 HR 持锁时调度跳过（SKIP LOCKED），释放后同日再跑开启且只开一次', async () => {
    const { db } = testDb();
    const w = await planWorld(db, 'idppgsched', { stages: scheduled });
    const plan = await w.startedPlan({ startDate: '2026-03-10' });
    let skipped: Awaited<ReturnType<typeof w.runScheduler>> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM idp_plans WHERE id = ${plan.id}::uuid FOR UPDATE`);
      skipped = await w.runScheduler('2026-03-09T18:30:00.000Z');
    });
    expect(skipped!.runs[0]).toMatchObject({ opened: [], failed: [], skippedLocked: 1 });
    expect((await w.readPlan(plan.id)).stages[0]).toMatchObject({ status: 'pending', attemptCount: 0 });

    const run = await w.runScheduler('2026-03-09T19:00:00.000Z');
    expect(run.runs[0]).toMatchObject({ opened: [plan.stages[0]!.id], skippedLocked: 0 });
    const again = await w.runScheduler('2026-03-09T19:30:00.000Z');
    expect(again.runs[0]!.opened).toEqual([]);
    const instances = rowsOf<{ n: number }>(
      await withTenant(db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM approval_instances WHERE business_type = 'idp'
          AND business_id = ${plan.stages[0]!.id}::uuid`),
      ),
    );
    expect(instances[0]!.n).toBe(1);
  });

  it('终止计划的事务未提交时员工新增目标：等待后读到已终止 → 403，目标不变', async () => {
    const { db } = testDb();
    const w = await planWorld(db, 'idppgterm');
    const plan = await w.startedPlan();
    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM idp_plans WHERE id = ${plan.id}::uuid FOR UPDATE`);
      pending = w.http(w.employee.userId, 'POST', `/api/tenant/idp/plans/${plan.id}/goals`, {
        ifMatch: plan.revision,
        body: { moduleId: w.goalModule.id, name: '并发新增的目标' },
      });
      await blocked(db, 1);
      await tx.execute(sql`UPDATE idp_plans SET status = 'terminated' WHERE id = ${plan.id}::uuid`);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(403);
    expect((await w.readPlan(plan.id)).goals!.map((g) => g.name)).toEqual(['提升跨部门沟通']);
  });
});
