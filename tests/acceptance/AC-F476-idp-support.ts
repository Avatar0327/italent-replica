/**
 * F-476 P8 IDP 验收夹具：办理（员工提交）→ 修改（指导人改目标 / 任务）→ 员工 / 指导人 / HR 三种读者读同一计划。
 * 内容用合成名称（ZZ_ 前缀）；办理份只经 withTenant 查询（app_owner + FORCE RLS 下也能通过）。
 * 断言只看业务结果（读到哪个名称），不依赖 ext 的内部形状，形状由实现决定。
 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { IDP, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import { resultRows } from './AC-ORG-people-support.js';

export const GOAL_A = 'ZZ_办理时目标';
export const GOAL_B = 'ZZ_指导人改后目标';
export const GOAL_C = 'ZZ_中期阶段目标';
export const TASK_A = 'ZZ_办理时任务';
export const TASK_B = 'ZZ_指导人改后任务';
export const ANALYSIS_A = 'ZZ_办理时个人综述';
export const SUMMARY = 'ZZ_中期总结';

/** 计划读取结果（参与人字段集 + 本片新增的内容来源说明）。 */
export type SeenPlan = PlanView & {
  contentView?: { mode: 'live' | 'frozen'; instanceId: string | null; taskId: string | null; round: number | null };
};

/** 某人读计划详情（真实授权器：员工 / 指导人只按参与关系；HR 夹具另用全部允许）。 */
export async function seen(w: PlanWorld, user: string, planId: string, query = ''): Promise<SeenPlan> {
  return w.ok<SeenPlan>(await w.realHttp(user, 'GET', `${IDP}/plans/${planId}${query}`));
}

/** 只看本测试造的合成目标（夹具计划自带一个通用目标，不参与比对）。 */
export const goalNames = (view: PlanView) =>
  (view.goals ?? []).map((goal) => goal.name).filter((name) => name.startsWith('ZZ_'));
export const taskNames = (view: PlanView) => (view.goals ?? []).flatMap((goal) => goal.tasks.map((task) => task.name));

export interface Handled {
  readonly plan: PlanView;
  readonly goalId: string;
  readonly taskId: string;
  readonly instanceId: string;
}

/**
 * 办理时 = A、事后 = B：员工填目标 A、任务 A、个人综述 A 并提交（办理份 #1）；指导人（在办）把目标、任务改成 B。
 * 此后员工的“已办”应读到 A，指导人在办读到 B。
 */
export async function handledThenModified(w: PlanWorld): Promise<Handled> {
  const started = await w.startedPlan();
  const withGoal = await w.addGoal(started, w.employee.userId, { name: GOAL_A });
  const goalId = withGoal.goals!.find((goal) => goal.name === GOAL_A)!.id;
  const path = `/plans/${started.id}`;
  const task = await w.ok<PlanView>(
    await w.execute(w.employee.userId, 'POST', `${path}/goals/${goalId}/tasks`, { name: TASK_A }),
    201,
  );
  const taskId = task.goals!.find((goal) => goal.id === goalId)!.tasks[0]!.id;
  await w.ok(
    await w.execute(w.employee.userId, 'PUT', `${path}/modules/${w.analysisModule.id}/content`, {
      currentAnalysis: ANALYSIS_A,
      developmentItems: 'ZZ_办理时发展项',
    }),
  );
  await w.submit(started, 1, w.employee.userId);
  await w.ok(await w.execute(w.manager.userId, 'PATCH', `${path}/goals/${goalId}`, { name: GOAL_B }));
  await w.ok(await w.execute(w.manager.userId, 'PATCH', `${path}/goals/${goalId}/tasks/${taskId}`, { name: TASK_B }));
  const plan = await w.readPlan(started.id);
  const instanceId = plan.stages[0]!.approvalInstanceId!;
  return { plan, goalId, taskId, instanceId };
}

export interface CopyRow {
  readonly instance_id: string;
  readonly actor_user_id: string | null;
  readonly node_key: string;
  readonly business_id: string;
  readonly text: string;
  readonly ext: { stage?: { id?: string }; goals?: { name: string }[]; analyses?: unknown[] } | null;
}

/** 某计划全部阶段实例的办理份（按日志序），含 ext；经 withTenant 读。 */
export async function copiesOfPlan(w: PlanWorld, planId: string): Promise<CopyRow[]> {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<CopyRow>(
      await tx.execute(sql`SELECT c.instance_id::text, c.actor_user_id::text, c.node_key, c.business_id::text,
        c.content::text AS text, c.content->'ext' AS ext
        FROM approval_handling_contents c
        JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
        JOIN idp_plan_stages s ON s.tenant_id = c.tenant_id AND s.id = c.business_id
        WHERE c.business_type = 'idp' AND s.plan_id = ${planId}::uuid
        ORDER BY l.created_at, l.seq`),
    ),
  );
}

/** 办理份必须带非空的真实详情（空 values 的通用快照不算通过，设计 §9 AC-15）。 */
export function expectRealDetail(copy: CopyRow | undefined) {
  expect(copy, '缺少办理份').toBeDefined();
  expect(copy!.ext, '办理份没有 IDP 扩展内容').not.toBeNull();
  expect(copy!.ext!.goals?.length ?? 0).toBeGreaterThan(0);
}

/** 办理份里的合成目标名（同样滤掉夹具自带的通用目标）。 */
export const copyGoalNames = (copy: CopyRow | undefined) =>
  (copy?.ext?.goals ?? []).map((goal) => goal.name).filter((name) => name.startsWith('ZZ_'));
