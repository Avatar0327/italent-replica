/**
 * 级联删除的子对象删除日志（K-34 / DEC-216；PR #115 第 2 轮 P2-10）：父对象删除前，逐个子对象写一条删除日志，
 * before = 删除前的完整内容，对象编号与写入时一致（目标回顾 = 目标:阶段、综述 = 计划:模块、回顾 = 计划:模块:阶段），
 * 与业务删除同事务；审计归属按计划员工。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from './access.js';
import type { PlanRow } from './plan-store.js';
import { audit, type WriteContext } from './write-support.js';

type Row = Record<string, unknown>;

const scoped = (plan: PlanRow, goalId?: string) =>
  goalId ? sql`plan_id = ${plan.id}::uuid AND goal_id = ${goalId}::uuid` : sql`plan_id = ${plan.id}::uuid`;

/** 目标的任务与目标回顾（goalId 缺省 = 计划下全部）。 */
export async function auditGoalChildren(tx: Tx, ctx: WriteContext, plan: PlanRow, goalId?: string) {
  const where = scoped(plan, goalId);
  const tasks = rowsOf<Row & { id: string }>(
    await tx.execute(sql`SELECT id, goal_id AS "goalId", name, description, owner_employee_id AS "ownerEmployeeId",
      start_date::text AS "startDate", end_date::text AS "endDate" FROM idp_goal_tasks
      WHERE tenant_id = ${ctx.tenantId} AND ${where} ORDER BY created_at, id`),
  );
  for (const task of tasks) {
    await audit(tx, ctx, 'task', 'delete', task.id, { before: task, after: null, employeeId: plan.employeeId });
  }
  const reviews = rowsOf<{ goalId: string; stageId: string; progress: number | null; outcome: string | null }>(
    await tx.execute(sql`SELECT goal_id AS "goalId", stage_id AS "stageId", progress, outcome FROM idp_goal_reviews
      WHERE tenant_id = ${ctx.tenantId} AND ${where} ORDER BY goal_id, stage_id`),
  );
  for (const review of reviews) {
    const before = { ...review, progress: review.progress === null ? null : Number(review.progress) };
    await audit(tx, ctx, 'goalReview', 'delete', `${review.goalId}:${review.stageId}`, {
      before,
      after: null,
      employeeId: plan.employeeId,
    });
  }
}

/** 计划的综述与回顾 / 总结。 */
export async function auditContents(tx: Tx, ctx: WriteContext, plan: PlanRow) {
  const analyses = rowsOf<Row & { moduleId: string }>(
    await tx.execute(sql`SELECT module_id AS "moduleId", current_analysis AS "currentAnalysis",
      development_items AS "developmentItems" FROM idp_plan_analyses
      WHERE tenant_id = ${ctx.tenantId} AND plan_id = ${plan.id}::uuid ORDER BY module_id`),
  );
  for (const analysis of analyses) {
    await audit(tx, ctx, 'analysis', 'delete', `${plan.id}:${analysis.moduleId}`, {
      before: analysis,
      after: null,
      employeeId: plan.employeeId,
    });
  }
  const reviews = rowsOf<Row & { moduleId: string; stageId: string }>(
    await tx.execute(sql`SELECT module_id AS "moduleId", stage_id AS "stageId", summary, improvement
      FROM idp_plan_reviews WHERE tenant_id = ${ctx.tenantId} AND plan_id = ${plan.id}::uuid
      ORDER BY module_id, stage_id`),
  );
  for (const review of reviews) {
    await audit(tx, ctx, 'review', 'delete', `${plan.id}:${review.moduleId}:${review.stageId}`, {
      before: review,
      after: null,
      employeeId: plan.employeeId,
    });
  }
}
