/**
 * 计划执行：执行人按“当前节点执行人 + 节点按钮”维护目标、任务、目标回顾、综述 / 回顾（DEC-296④；PR 描述 K-12 /
 * K-14 / K-47 / K-49；IDP-R8 / R10）。执行人没有 IDP 身份，写入按节点按钮放行固定字段集，不查 IDP 字段权限；
 * 胜任力库目标只回填指标的名称 / 定义 / 类别（DEC-307，入口清单 E4 / E5）。
 * 每次写入推进计划 revision（If-Match = 计划 revision），与业务同事务写审计（按计划员工归属）。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate, type CompetencySource, type NodeButton } from '@italent/domain';
import { AppError } from '../../errors.js';
import { rowsOf } from './access.js';
import { auditGoalChildren } from './cascade-audit.js';
import { type CandidateIndicator, competencyCandidates } from './competency.js';
import { type Executor, requireExecutor } from './plan-access.js';
import type {
  GoalCreate,
  GoalPatch,
  GoalReviewInput,
  ModuleContentInput,
  TaskCreate,
  TaskPatch,
} from './plan-input.js';
import type { PlanWriteContext } from './plan-service.js';
import { bumpPlan, loadStages, type PlanRow, requirePlanRow } from './plan-store.js';
import { loadPlanDetail } from './plan-view.js';
import { audit, conflict, requireRevision } from './write-support.js';

interface ModuleRow {
  readonly id: string;
  readonly module_type: string;
  readonly allow_custom_goal: boolean | null;
  readonly allow_library_goal: boolean | null;
  readonly competency_source: CompetencySource | null;
  readonly goal_review_enabled: boolean | null;
  readonly task_enabled: boolean | null;
}

/** 计划所用模板的模块（不属于该模板 → 404）。 */
async function moduleOf(tx: Tx, plan: PlanRow, moduleId: string): Promise<ModuleRow> {
  const [row] = rowsOf<ModuleRow>(
    await tx.execute(sql`SELECT id, module_type, allow_custom_goal, allow_library_goal, competency_source,
      goal_review_enabled, task_enabled FROM idp_template_modules
      WHERE tenant_id = ${plan.tenantId} AND template_id = ${plan.templateId}::uuid AND id = ${moduleId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '发展计划模块不存在');
  return row;
}

async function goalOf(tx: Tx, plan: PlanRow, goalId: string) {
  const [row] = rowsOf<Record<string, unknown> & { id: string; moduleId: string }>(
    await tx.execute(sql`SELECT id, module_id AS "moduleId", name, measure, suggestion,
      start_date::text AS "startDate", end_date::text AS "endDate", display_order AS "displayOrder",
      source_type AS "sourceType", indicator_id AS "indicatorId" FROM idp_goals
      WHERE tenant_id = ${plan.tenantId} AND plan_id = ${plan.id}::uuid AND id = ${goalId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '发展目标不存在');
  return row;
}

/** 写入前：锁计划 → 执行人与按钮（404 / 403）→ revision（409）。 */
async function executorFor(
  tx: Tx,
  ctx: PlanWriteContext,
  planId: string,
  moduleId: string,
  button: NodeButton,
): Promise<{ plan: PlanRow; module: ModuleRow; executor: Executor }> {
  const plan = await requirePlanRow(tx, ctx.tenantId, planId, true);
  const stages = await loadStages(tx, ctx.tenantId, [plan.id]);
  const executor = await requireExecutor(tx, ctx, ctx.hr, plan, stages, moduleId, button);
  const module = await moduleOf(tx, plan, moduleId);
  requireRevision(ctx, plan.revision, '发展计划');
  return { plan, module, executor };
}

/** 返回前与重放时复核：调用人当前仍是该模块该按钮的执行人（重放不放过已变的节点，K-49）。 */
export async function recheckExecutor(
  tx: Tx,
  ctx: PlanWriteContext,
  planId: string,
  moduleId: string,
  buttons: NodeButton | readonly NodeButton[],
): Promise<void> {
  const plan = await requirePlanRow(tx, ctx.tenantId, planId);
  const stages = await loadStages(tx, ctx.tenantId, [planId]);
  for (const button of typeof buttons === 'string' ? [buttons] : buttons) {
    await requireExecutor(tx, ctx, ctx.hr, plan, stages, moduleId, button);
  }
}

async function finish(tx: Tx, ctx: PlanWriteContext, plan: PlanRow) {
  await bumpPlan(tx, ctx.tenantId, plan.id, ctx.now);
  return loadPlanDetail(tx, await requirePlanRow(tx, ctx.tenantId, plan.id), tenantLocalDate(ctx.now, ctx.timezone));
}

const requireGoalModule = (module: ModuleRow) => {
  if (module.module_type !== 'goal') conflict('IDP_MODULE_NOT_GOAL', '只能在发展目标模块下维护目标');
};

/** 胜任力库候选（DEC-307，K-14）：当前节点执行人 + RowAddIdpGoal；只列本计划已确定来源下的已启用指标、三项字段。 */
export async function candidates(tx: Tx, ctx: PlanWriteContext, planId: string, moduleId: string) {
  const plan = await requirePlanRow(tx, ctx.tenantId, planId);
  await requireExecutor(tx, ctx, ctx.hr, plan, await loadStages(tx, ctx.tenantId, [planId]), moduleId, 'RowAddIdpGoal');
  const module = await moduleOf(tx, plan, moduleId);
  requireGoalModule(module);
  return libraryCandidates(tx, ctx, plan, module);
}

async function libraryCandidates(tx: Tx, ctx: PlanWriteContext, plan: PlanRow, module: ModuleRow) {
  // 开关参数“新建目标时允许从胜任力库中选择”缺省“是”（🟡 K-18），模块未允许引用时没有候选
  if (module.allow_library_goal === false || !module.competency_source) return [];
  return competencyCandidates(tx, {
    tenantId: ctx.tenantId,
    employeeId: plan.employeeId,
    source: module.competency_source,
    asOf: tenantLocalDate(ctx.now, ctx.timezone),
    plan: { startDate: plan.startDate, endDate: plan.endDate },
  });
}

async function indicatorFor(tx: Tx, ctx: PlanWriteContext, plan: PlanRow, module: ModuleRow, id: string) {
  const found = (await libraryCandidates(tx, ctx, plan, module)).find((c: CandidateIndicator) => c.id === id);
  if (!found) conflict('IDP_INDICATOR_UNAVAILABLE', '所选指标不在本计划的胜任力来源中或已停用');
  return found;
}

export async function addGoal(tx: Tx, ctx: PlanWriteContext, planId: string, input: GoalCreate) {
  const { plan, module } = await executorFor(tx, ctx, planId, input.moduleId, 'RowAddIdpGoal');
  requireGoalModule(module);
  const indicator = input.indicatorId ? await indicatorFor(tx, ctx, plan, module, input.indicatorId) : null;
  if (!indicator && module.allow_custom_goal === false) conflict('IDP_CUSTOM_GOAL_DISABLED', '该模块不允许自定义目标');
  const values = {
    moduleId: module.id,
    name: input.name ?? indicator!.name,
    measure: input.measure ?? null,
    suggestion: input.suggestion ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    sourceType: indicator ? 'library' : 'custom',
    indicatorId: indicator?.id ?? null,
    indicatorName: indicator?.name ?? null,
    indicatorDefinition: indicator?.definition ?? null,
    indicatorCategory: indicator?.category ?? null,
    displayOrder: input.displayOrder ?? 0,
  };
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`INSERT INTO idp_goals (tenant_id, plan_id, module_id, name, measure, suggestion, start_date,
      end_date, source_type, indicator_id, indicator_name, indicator_definition, indicator_category, display_order,
      created_by, created_at)
      VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${values.moduleId}::uuid, ${values.name}, ${values.measure},
        ${values.suggestion}, ${values.startDate}::date, ${values.endDate}::date, ${values.sourceType},
        ${values.indicatorId}::uuid, ${values.indicatorName}, ${values.indicatorDefinition},
        ${values.indicatorCategory}, ${values.displayOrder}, ${ctx.userId}::uuid, ${ctx.now.toISOString()})
      RETURNING id`),
  );
  await audit(tx, ctx, 'goal', 'create', row!.id, {
    before: null,
    after: { planId: plan.id, ...values },
    employeeId: plan.employeeId,
  });
  return finish(tx, ctx, plan);
}

const GOAL_COLUMNS = {
  name: 'name',
  measure: 'measure',
  suggestion: 'suggestion',
  startDate: 'start_date',
  endDate: 'end_date',
  displayOrder: 'display_order',
} as const;

export async function updateGoal(tx: Tx, ctx: PlanWriteContext, planId: string, goalId: string, patch: GoalPatch) {
  const head = await requirePlanRow(tx, ctx.tenantId, planId);
  const goal = await goalOf(tx, head, goalId);
  const { plan } = await executorFor(tx, ctx, planId, goal.moduleId, 'RowEditIdpGoal');
  const before = await goalOf(tx, plan, goalId);
  const merged = {
    startDate: patch.startDate === undefined ? (before.startDate as string | null) : patch.startDate,
    endDate: patch.endDate === undefined ? (before.endDate as string | null) : patch.endDate,
  };
  if (merged.startDate && merged.endDate && merged.endDate < merged.startDate) {
    throw new AppError('VALIDATION_FAILED', '结束时间不能早于开始时间');
  }
  for (const [key, column] of Object.entries(GOAL_COLUMNS)) {
    const value = patch[key as keyof GoalPatch];
    if (value === undefined) continue;
    const cast = column.endsWith('_date') ? sql`::date` : sql``;
    await tx.execute(sql`UPDATE idp_goals SET ${sql.raw(column)} = ${value}${cast}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${goalId}::uuid`);
  }
  await audit(tx, ctx, 'goal', 'update', goalId, {
    before,
    after: await goalOf(tx, plan, goalId),
    employeeId: plan.employeeId,
  });
  return finish(tx, ctx, plan);
}

/**
 * 删除目标级联删除其任务与目标回顾：执行人还须有子对象的删除权——任务 / 目标回顾挂在本模块的 RowEditIdpGoal 上
 * （🟡 K-12）。不论子对象是否存在都要求，缺了整次 403（DEC-309④-2 级联清单的目标层，第 2 轮 P2-7）。
 */
export const GOAL_DELETE_BUTTONS: readonly NodeButton[] = ['RowDeleteIdpGoal', 'RowEditIdpGoal'];

export async function deleteGoal(tx: Tx, ctx: PlanWriteContext, planId: string, goalId: string) {
  const head = await requirePlanRow(tx, ctx.tenantId, planId);
  const goal = await goalOf(tx, head, goalId);
  const { plan } = await executorFor(tx, ctx, planId, goal.moduleId, 'RowDeleteIdpGoal');
  await recheckExecutor(tx, ctx, planId, goal.moduleId, 'RowEditIdpGoal');
  // 目标的删除快照含其任务与目标回顾；子对象各写删除日志（P2-10）
  const snapshot = (await loadPlanDetail(tx, plan, tenantLocalDate(ctx.now, ctx.timezone))).goals.find(
    (g) => g.id === goalId,
  );
  await auditGoalChildren(tx, ctx, plan, goalId);
  await tx.execute(sql`DELETE FROM idp_goals WHERE tenant_id = ${ctx.tenantId} AND id = ${goalId}::uuid`);
  await audit(tx, ctx, 'goal', 'delete', goalId, {
    before: { ...goal, tasks: snapshot?.tasks ?? [], reviews: snapshot?.reviews ?? [] },
    after: null,
    employeeId: plan.employeeId,
  });
  return finish(tx, ctx, plan);
}

/** 任务、目标回顾挂在发展目标模块的 RowEditIdpGoal 上（🟡 K-12），并受模块开关约束（IDP-R10）。 */
async function goalExecutor(tx: Tx, ctx: PlanWriteContext, planId: string, goalId: string) {
  const head = await requirePlanRow(tx, ctx.tenantId, planId);
  const goal = await goalOf(tx, head, goalId);
  return { goal, ...(await executorFor(tx, ctx, planId, goal.moduleId, 'RowEditIdpGoal')) };
}

async function taskOf(tx: Tx, plan: PlanRow, goalId: string, taskId: string) {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT id, goal_id AS "goalId", name, description, owner_employee_id AS "ownerEmployeeId",
      start_date::text AS "startDate", end_date::text AS "endDate" FROM idp_goal_tasks
      WHERE tenant_id = ${plan.tenantId} AND plan_id = ${plan.id}::uuid
      AND goal_id = ${goalId}::uuid AND id = ${taskId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '目标任务不存在');
  return row;
}

export async function insertTask(tx: Tx, ctx: PlanWriteContext, plan: PlanRow, goalId: string, input: TaskCreate) {
  const values = {
    goalId,
    name: input.name,
    description: input.description ?? null,
    ownerEmployeeId: input.ownerEmployeeId ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
  };
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`INSERT INTO idp_goal_tasks (tenant_id, plan_id, goal_id, name, description,
      owner_employee_id, start_date, end_date, created_by, created_at)
      VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${goalId}::uuid, ${values.name}, ${values.description},
        ${values.ownerEmployeeId}::uuid, ${values.startDate}::date, ${values.endDate}::date, ${ctx.userId}::uuid,
        ${ctx.now.toISOString()}) RETURNING id`),
  );
  await audit(tx, ctx, 'task', 'create', row!.id, {
    before: null,
    after: { planId: plan.id, ...values },
    employeeId: plan.employeeId,
  });
  return row!.id;
}

export async function addTask(tx: Tx, ctx: PlanWriteContext, planId: string, goalId: string, input: TaskCreate) {
  const { plan, module } = await goalExecutor(tx, ctx, planId, goalId);
  if (module.task_enabled !== true) conflict('IDP_TASK_DISABLED', '该发展目标模块未开启制定任务');
  await insertTask(tx, ctx, plan, goalId, input);
  return finish(tx, ctx, plan);
}

const TASK_COLUMNS = {
  name: 'name',
  description: 'description',
  ownerEmployeeId: 'owner_employee_id',
  startDate: 'start_date',
  endDate: 'end_date',
} as const;

export async function updateTask(
  tx: Tx,
  ctx: PlanWriteContext,
  ids: { planId: string; goalId: string; taskId: string },
  patch: TaskPatch,
) {
  const { plan, module } = await goalExecutor(tx, ctx, ids.planId, ids.goalId);
  if (module.task_enabled !== true) conflict('IDP_TASK_DISABLED', '该发展目标模块未开启制定任务');
  const before = await taskOf(tx, plan, ids.goalId, ids.taskId);
  for (const [key, column] of Object.entries(TASK_COLUMNS)) {
    const value = patch[key as keyof TaskPatch];
    if (value === undefined) continue;
    const cast = column.endsWith('_date') ? sql`::date` : column.endsWith('_id') ? sql`::uuid` : sql``;
    await tx.execute(sql`UPDATE idp_goal_tasks SET ${sql.raw(column)} = ${value}${cast}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${ids.taskId}::uuid`);
  }
  const after = await taskOf(tx, plan, ids.goalId, ids.taskId);
  if (after.startDate && after.endDate && (after.endDate as string) < (after.startDate as string)) {
    throw new AppError('VALIDATION_FAILED', '结束时间不能早于开始时间');
  }
  await audit(tx, ctx, 'task', 'update', ids.taskId, { before, after, employeeId: plan.employeeId });
  return finish(tx, ctx, plan);
}

export async function deleteTask(
  tx: Tx,
  ctx: PlanWriteContext,
  ids: { planId: string; goalId: string; taskId: string },
) {
  const { plan } = await goalExecutor(tx, ctx, ids.planId, ids.goalId);
  const before = await taskOf(tx, plan, ids.goalId, ids.taskId);
  await tx.execute(sql`DELETE FROM idp_goal_tasks WHERE tenant_id = ${ctx.tenantId} AND id = ${ids.taskId}::uuid`);
  await audit(tx, ctx, 'task', 'delete', ids.taskId, { before, after: null, employeeId: plan.employeeId });
  return finish(tx, ctx, plan);
}

/** 目标回顾（IDP-R10 目标回顾开关）：每个目标在当前阶段一份。 */
export async function saveGoalReview(
  tx: Tx,
  ctx: PlanWriteContext,
  planId: string,
  goalId: string,
  input: GoalReviewInput,
) {
  const { plan, module, executor } = await goalExecutor(tx, ctx, planId, goalId);
  if (module.goal_review_enabled !== true) conflict('IDP_GOAL_REVIEW_DISABLED', '该发展目标模块未开启目标回顾');
  const stageId = executor.stage.id;
  const [before] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT progress, outcome FROM idp_goal_reviews WHERE tenant_id = ${ctx.tenantId}
      AND goal_id = ${goalId}::uuid AND stage_id = ${stageId}::uuid`),
  );
  const progress = input.progress === undefined ? ((before?.progress as number | null) ?? null) : input.progress;
  const outcome = input.outcome === undefined ? ((before?.outcome as string | null) ?? null) : input.outcome;
  await tx.execute(sql`INSERT INTO idp_goal_reviews (tenant_id, plan_id, goal_id, stage_id, progress, outcome,
      updated_by, updated_at)
    VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${goalId}::uuid, ${stageId}::uuid, ${progress}, ${outcome},
      ${ctx.userId}::uuid, ${ctx.now.toISOString()})
    ON CONFLICT (tenant_id, goal_id, stage_id) DO UPDATE SET progress = EXCLUDED.progress,
      outcome = EXCLUDED.outcome, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`);
  await audit(tx, ctx, 'goalReview', before ? 'update' : 'create', `${goalId}:${stageId}`, {
    before: before ? { goalId, stageId, ...before } : null,
    after: { goalId, stageId, progress, outcome },
    employeeId: plan.employeeId,
  });
  return finish(tx, ctx, plan);
}

const CONTENT_FIELDS = {
  analysis: ['currentAnalysis', 'developmentItems'],
  review: ['summary', 'improvement'],
  summary: ['summary', 'improvement'],
} as const;

/** 综述 / 回顾 / 总结模块内容（🟡 K-12：节点按钮 EditModuleContent）。回顾 / 总结按当前阶段各一份。 */
export async function saveModuleContent(
  tx: Tx,
  ctx: PlanWriteContext,
  planId: string,
  moduleId: string,
  input: ModuleContentInput,
) {
  const { plan, module, executor } = await executorFor(tx, ctx, planId, moduleId, 'EditModuleContent');
  const kind = module.module_type as keyof typeof CONTENT_FIELDS;
  const allowed: readonly string[] = CONTENT_FIELDS[kind] ?? [];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (!allowed.length || extra.length) {
    throw new AppError('VALIDATION_FAILED', '该模块不能填写这些内容', { fields: extra });
  }
  if (kind === 'analysis') await saveAnalysis(tx, ctx, plan, moduleId, input);
  else await saveReview(tx, ctx, plan, moduleId, executor.stage.id, input);
  return finish(tx, ctx, plan);
}

async function saveAnalysis(tx: Tx, ctx: PlanWriteContext, plan: PlanRow, moduleId: string, input: ModuleContentInput) {
  const [before] = rowsOf<{ current_analysis: string | null; development_items: string | null }>(
    await tx.execute(sql`SELECT current_analysis, development_items FROM idp_plan_analyses
      WHERE tenant_id = ${ctx.tenantId} AND plan_id = ${plan.id}::uuid AND module_id = ${moduleId}::uuid`),
  );
  const after = {
    currentAnalysis: input.currentAnalysis === undefined ? (before?.current_analysis ?? null) : input.currentAnalysis,
    developmentItems:
      input.developmentItems === undefined ? (before?.development_items ?? null) : input.developmentItems,
  };
  await tx.execute(sql`INSERT INTO idp_plan_analyses (tenant_id, plan_id, module_id, current_analysis,
      development_items, updated_by, updated_at)
    VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${moduleId}::uuid, ${after.currentAnalysis}, ${after.developmentItems},
      ${ctx.userId}::uuid, ${ctx.now.toISOString()})
    ON CONFLICT (tenant_id, plan_id, module_id) DO UPDATE SET current_analysis = EXCLUDED.current_analysis,
      development_items = EXCLUDED.development_items, updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at`);
  await audit(tx, ctx, 'analysis', before ? 'update' : 'create', `${plan.id}:${moduleId}`, {
    before: before
      ? { moduleId, currentAnalysis: before.current_analysis, developmentItems: before.development_items }
      : null,
    after: { moduleId, ...after },
    employeeId: plan.employeeId,
  });
}

async function saveReview(
  tx: Tx,
  ctx: PlanWriteContext,
  plan: PlanRow,
  moduleId: string,
  stageId: string,
  input: ModuleContentInput,
) {
  const [before] = rowsOf<{ summary: string | null; improvement: string | null }>(
    await tx.execute(sql`SELECT summary, improvement FROM idp_plan_reviews WHERE tenant_id = ${ctx.tenantId}
      AND plan_id = ${plan.id}::uuid AND module_id = ${moduleId}::uuid AND stage_id = ${stageId}::uuid`),
  );
  const after = {
    summary: input.summary === undefined ? (before?.summary ?? null) : input.summary,
    improvement: input.improvement === undefined ? (before?.improvement ?? null) : input.improvement,
  };
  await tx.execute(sql`INSERT INTO idp_plan_reviews (tenant_id, plan_id, module_id, stage_id, summary, improvement,
      updated_by, updated_at)
    VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${moduleId}::uuid, ${stageId}::uuid, ${after.summary},
      ${after.improvement}, ${ctx.userId}::uuid, ${ctx.now.toISOString()})
    ON CONFLICT (tenant_id, plan_id, module_id, stage_id) DO UPDATE SET summary = EXCLUDED.summary,
      improvement = EXCLUDED.improvement, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`);
  await audit(tx, ctx, 'review', before ? 'update' : 'create', `${plan.id}:${moduleId}:${stageId}`, {
    before: before ? { moduleId, stageId, ...before } : null,
    after: { moduleId, stageId, ...after },
    employeeId: plan.employeeId,
  });
}
