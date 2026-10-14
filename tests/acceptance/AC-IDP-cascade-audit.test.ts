/**
 * R3-T07 PR-B 第 2 轮 P2-10：级联删除时子对象也写删除日志、留快照（K-34 / DEC-216 / AGENTS §5“删除时保留快照”）。
 * - 删除目标：任务、目标回顾各写一条删除日志，before 为删除前的完整行；目标的删除快照含其任务与目标回顾；
 * - 删除计划：目标、任务、目标回顾、综述、回顾 / 总结都写删除日志；目标快照不剥掉子内容。
 */
import { IDP_OBJECTS } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

interface DeleteLog {
  object_type: string;
  object_id: string;
  before: Record<string, unknown> | null;
}

async function deleteLogs(w: PlanWorld, objectType: string): Promise<DeleteLog[]> {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT object_type, object_id, before FROM audit_events
      WHERE tenant_id = ${w.tenant.id} AND object_type = ${objectType} AND action LIKE '%.delete'`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as DeleteLog[];
  });
}

/** 开始的计划：一个目标带一条任务与一条目标回顾，综述已填。 */
async function filledPlan(w: PlanWorld) {
  let plan = await w.startedPlan();
  plan = await w.addGoal(plan, w.employee.userId, { name: '级联目标' });
  const goal = plan.goals!.find((g) => g.name === '级联目标')!;
  await w.ok(
    await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals/${goal.id}/tasks`, {
      name: '级联任务',
      description: '任务说明',
    }),
    201,
  );
  await w.ok(
    await w.execute(w.employee.userId, 'PUT', `/plans/${plan.id}/goals/${goal.id}/review`, {
      progress: 30,
      outcome: '级联回顾成果',
    }),
  );
  await w.ok(
    await w.execute(w.employee.userId, 'PUT', `/plans/${plan.id}/modules/${w.analysisModule.id}/content`, {
      currentAnalysis: '级联综述',
      developmentItems: '待发展项',
    }),
  );
  const view = await w.readPlan(plan.id);
  return { plan: view, goal: view.goals!.find((g) => g.id === goal.id)! };
}

describe('P2-10：级联删除的子对象日志与快照', () => {
  it('删除目标：任务与目标回顾各写删除日志，目标快照含子内容', async () => {
    const w = await planWorld(testDb().db, 'idp-cascade-goal');
    const { plan, goal } = await filledPlan(w);
    const removed = await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${goal.id}`);
    expect(removed.status, await removed.clone().text()).toBe(200);
    const tasks = await deleteLogs(w, IDP_OBJECTS.task.code);
    expect(tasks).toEqual([
      expect.objectContaining({
        object_id: goal.tasks[0]!.id,
        before: expect.objectContaining({ name: '级联任务', description: '任务说明', goalId: goal.id }),
      }),
    ]);
    const reviews = await deleteLogs(w, IDP_OBJECTS.goalReview.code);
    expect(reviews).toEqual([
      expect.objectContaining({ before: expect.objectContaining({ goalId: goal.id, outcome: '级联回顾成果' }) }),
    ]);
    const [goalLog] = await deleteLogs(w, IDP_OBJECTS.goal.code);
    expect(JSON.stringify(goalLog!.before)).toContain('级联任务');
    expect(JSON.stringify(goalLog!.before)).toContain('级联回顾成果');
  });

  it('删除计划：目标、任务、目标回顾、综述都写删除日志，目标快照不剥子内容', async () => {
    const w = await planWorld(testDb().db, 'idp-cascade-plan');
    const { plan } = await filledPlan(w);
    const removed = await w.http(w.hrUser, 'DELETE', `/api/tenant/idp/plans/${plan.id}`, {
      ifMatch: (await w.readPlan(plan.id)).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(((await removed.json()) as PlanView).goals![0]!.tasks).toHaveLength(1);
    for (const object of ['goal', 'task', 'goalReview', 'analysis'] as const) {
      const logs = await deleteLogs(w, IDP_OBJECTS[object].code);
      expect(logs.length, object).toBeGreaterThan(0);
      for (const log of logs) expect(log.before, object).not.toBeNull();
    }
    const [goalLog] = await deleteLogs(w, IDP_OBJECTS.goal.code);
    expect(JSON.stringify(goalLog!.before)).toContain('级联任务');
    expect(JSON.stringify((await deleteLogs(w, IDP_OBJECTS.analysis.code))[0]!.before)).toContain('级联综述');
  });
});
