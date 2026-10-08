/**
 * 发展计划的读模型与按查看人呈现（PR 描述矩阵第二节、入口清单 E6 / E7）。
 * - 阶段：子流程名称、状态、到期日（按开启规则与参照日计算，K-05～K-07）、结束日、开启失败原因与次数；
 *   当前阶段 / 当前节点（努力提升中，K-03）；
 * - 目标（含任务、各阶段的目标回顾）、综述、回顾 / 总结；模板模块结构（计划读模板当前配置，IDP-R12 实时生效）；
 * - 关键信息：与计划起止有交集的带教 / 职业发展 / 轮岗记录（IDP-R7、AC-IDP-07）；储备人才（R3-T06 未做）为空。
 * 呈现：HR 各段按对象字段权限裁剪；参与人按固定字段集（DEC-296④），关键信息仍按其对源对象的字段查看权（DEC-309，E6）。
 */
import { sql, type Tx } from '@italent/db';
import {
  currentStageName,
  IMPROVING_STAGE_NAME,
  MODULE_OBJECTS,
  periodsIntersect,
  RULE_TEXT_SOURCES,
  stageDueDate,
  tenantLocalDate,
  type IdpObject,
} from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { isEmploymentRecordVisible } from '../employment/visibility.js';
import { getModuleViewableFields, resolveModuleScope } from '../permission/module-access.js';
import { codeOf, type IdpContext, type ModuleScope, project, type Projection, projectionOf, rowsOf } from './access.js';
import { KEY_INFO, KEY_INFO_KINDS, type KeyInfoKind } from './key-info-scope.js';
import { inScope } from './key-info-service.js';
import type { PlanViewer } from './plan-access.js';
import { nodeButtons } from './plan-access.js';
import { currentNodes, loadStages, type PlanRow, type StageRow } from './plan-store.js';
import { loadModuleRows, loadNodeSettings, moduleView, type ModuleView } from './read-model.js';

export interface StageView {
  readonly id: string;
  readonly subProcessId: string;
  readonly seq: number;
  readonly name: string;
  readonly status: StageRow['status'];
  readonly approvalInstanceId: string | null;
  readonly dueDate: string | null;
  readonly endedOn: string | null;
  readonly failureReason: string | null;
  readonly attemptCount: number;
  /** dueDate 依据的源（内部，呈现前按查看人裁剪后去掉，E10）。 */
  readonly dueBasis: readonly DueBasis[];
}

/** dueDate 依据的源：子流程开启规则（与 ruleText 同一组字段，含 fixedDate）、计划起止、任职生效日。 */
export type DueBasis = 'rule' | 'planStart' | 'planEnd' | 'employment';

const REFERENCE_BASIS: Readonly<Record<string, DueBasis | null>> = {
  plan_start: 'planStart',
  plan_end: 'planEnd',
  previous_end: null,
  employment_effective: 'employment',
};

/** 与 stageDueDate 的分支一一对应。 */
function dueBasisOf(stage: StageRow, index: number): DueBasis[] {
  if (stage.startMode === 'manual' || stage.startTimeType === 'fixed') return ['rule'];
  if (stage.startTimeType === null) return index === 0 ? ['rule', 'planStart'] : ['rule'];
  const reference = REFERENCE_BASIS[stage.referencePoint!];
  return reference ? ['rule', reference] : ['rule'];
}

export interface GoalView {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly measure: string | null;
  readonly suggestion: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly sourceType: string;
  readonly commonGoalId: string | null;
  readonly indicatorId: string | null;
  readonly indicatorName: string | null;
  readonly indicatorDefinition: string | null;
  readonly indicatorCategory: string | null;
  readonly displayOrder: number;
  readonly tasks: Record<string, unknown>[];
  readonly reviews: Record<string, unknown>[];
}

export interface KeyInfo {
  readonly tutorships: Record<string, unknown>[];
  readonly careers: Record<string, unknown>[];
  readonly workShifts: Record<string, unknown>[];
}

export interface PlanDetail {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly employeeId: string;
  readonly templateId: string;
  readonly processId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly tutorRole: string;
  readonly tutorEmployeeId: string;
  readonly status: PlanRow['status'];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentStageName: string | null;
  readonly currentNodeName: string | null;
  readonly stages: StageView[];
  readonly modules: ModuleView[];
  readonly goals: GoalView[];
  readonly analyses: Record<string, unknown>[];
  readonly reviews: Record<string, unknown>[];
  readonly keyInfo: KeyInfo;
}

/** 计划行的审计 / 台账快照（不含派生与组成部分）。 */
export function planRecord(row: PlanRow) {
  return {
    id: row.id,
    name: row.name,
    employeeId: row.employeeId,
    templateId: row.templateId,
    processId: row.processId,
    startDate: row.startDate,
    endDate: row.endDate,
    tutorRole: row.tutorRole,
    tutorEmployeeId: row.tutorEmployeeId,
    status: row.status,
  };
}

/** 员工最新一条已生效主职任职记录的生效日（参照点“任职记录生效时间”，🟡 K-07）。 */
async function employmentEffective(tx: Tx, tenantId: string, employeeId: string, asOf: string) {
  const record = await findCurrentRecord(tx, tenantId, employeeId, asOf);
  return (record?.effectiveDate as string | undefined) ?? null;
}

export async function stageViews(tx: Tx, plan: PlanRow, stages: readonly StageRow[], asOf: string) {
  const needsEmployment = stages.some((s) => s.referencePoint === 'employment_effective');
  const effective = needsEmployment ? await employmentEffective(tx, plan.tenantId, plan.employeeId, asOf) : null;
  return stages.map((stage, index): StageView => {
    const previous = index > 0 ? stages[index - 1]! : null;
    const dueDate = stageDueDate(stage, index, {
      planStart: plan.startDate,
      planEnd: plan.endDate,
      previousEnd: previous?.status === 'ended' ? previous.endedOn : null,
      employmentEffective: effective,
    });
    return {
      id: stage.id,
      subProcessId: stage.subProcessId,
      seq: stage.seq,
      name: stage.name,
      status: stage.status,
      approvalInstanceId: stage.approvalInstanceId,
      dueDate,
      endedOn: stage.endedOn,
      failureReason: stage.failureReason,
      attemptCount: stage.attemptCount,
      dueBasis: dueBasisOf(stage, index),
    };
  });
}

/** 阶段带出值的源字段查看权（HR 呈现，E9 / E10）；参与人按 DEC-296④ 固定字段集，传 null。 */
export interface StageSources {
  readonly subProcess: Projection;
  readonly plan: Projection;
  readonly employment: { readonly fields: Projection; readonly scope: ModuleScope };
}

const sees = (projection: Projection, field: string) =>
  projection !== null && (projection === undefined || projection.has(field));

/**
 * 阶段呈现：阶段名称来自子流程 name，dueDate 由开启规则 / 计划起止 / 任职生效日推算——看不到任一来源就不输出
 * （DEC-309；第 2 轮 P2-4）。任职生效日另须员工当前任职记录在操作人任职记录范围内（与任职记录接口同一判定）。
 */
export async function stagesShown(
  tx: Tx,
  plan: Pick<PlanRow, 'tenantId' | 'employeeId'>,
  stages: readonly StageView[],
  sources: StageSources | null,
  asOf: string,
): Promise<Record<string, unknown>[]> {
  if (sources === null) return stages.map(({ dueBasis: _b, ...stage }) => stage);
  let employment: boolean | undefined;
  const allowed = async (basis: DueBasis) => {
    if (basis === 'rule')
      return sources.subProcess !== null && RULE_TEXT_SOURCES.every((field) => sees(sources.subProcess, field));
    if (basis === 'planStart') return sees(sources.plan, 'startDate');
    if (basis === 'planEnd') return sees(sources.plan, 'endDate');
    employment ??= await employmentVisible(tx, plan, sources.employment, asOf);
    return employment;
  };
  const shown: Record<string, unknown>[] = [];
  for (const { dueBasis, name, dueDate, ...stage } of stages) {
    let due = true;
    for (const basis of dueBasis) due &&= await allowed(basis);
    shown.push({
      ...stage,
      ...(sees(sources.subProcess, 'name') ? { name } : {}),
      ...(due ? { dueDate } : {}),
    });
  }
  return shown;
}

async function employmentVisible(
  tx: Tx,
  plan: Pick<PlanRow, 'tenantId' | 'employeeId'>,
  employment: StageSources['employment'],
  asOf: string,
) {
  if (!sees(employment.fields, 'effectiveDate')) return false;
  const record = await findCurrentRecord(tx, plan.tenantId, plan.employeeId, asOf);
  if (!record) return true;
  const departmentId = (record.fields.departmentId as string | null | undefined) ?? null;
  return isEmploymentRecordVisible(tx, plan.tenantId, employment.scope, { employeeId: plan.employeeId, departmentId });
}

/** 当前阶段名是某段的子流程名称时随名称一起裁剪；“努力提升中”是固定文案，不是带出值。 */
export function currentStageShown(value: string | null, sources: StageSources | null): string | null {
  if (sources === null || value === null || value === IMPROVING_STAGE_NAME) return value;
  return sees(sources.subProcess, 'name') ? value : null;
}

async function loadGoals(tx: Tx, tenantId: string, planId: string): Promise<GoalView[]> {
  const goals = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT id, module_id AS "moduleId", name, measure, suggestion,
      start_date::text AS "startDate", end_date::text AS "endDate", source_type AS "sourceType",
      common_goal_id AS "commonGoalId", indicator_id AS "indicatorId", indicator_name AS "indicatorName",
      indicator_definition AS "indicatorDefinition", indicator_category AS "indicatorCategory",
      display_order AS "displayOrder"
      FROM idp_goals WHERE tenant_id = ${tenantId} AND plan_id = ${planId}::uuid
      ORDER BY display_order, created_at, id`),
  );
  const tasks = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT id, goal_id AS "goalId", name, description, owner_employee_id AS "ownerEmployeeId",
      start_date::text AS "startDate", end_date::text AS "endDate"
      FROM idp_goal_tasks WHERE tenant_id = ${tenantId} AND plan_id = ${planId}::uuid ORDER BY created_at, id`),
  );
  const reviews = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT r.goal_id AS "goalId", r.stage_id AS "stageId", r.progress, r.outcome
      FROM idp_goal_reviews r JOIN idp_plan_stages s ON s.tenant_id = r.tenant_id AND s.id = r.stage_id
      WHERE r.tenant_id = ${tenantId} AND r.plan_id = ${planId}::uuid ORDER BY s.seq`),
  );
  return goals.map((goal) => ({
    ...(goal as unknown as Omit<GoalView, 'tasks' | 'reviews'>),
    displayOrder: Number(goal.displayOrder),
    tasks: tasks.filter((t) => t.goalId === goal.id).map(({ goalId: _g, ...task }) => task),
    reviews: reviews
      .filter((r) => r.goalId === goal.id)
      .map(({ goalId: _g, progress, ...review }) => ({
        ...review,
        progress: progress === null ? null : Number(progress),
      })),
  }));
}

async function loadContents(tx: Tx, tenantId: string, planId: string) {
  const analyses = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT module_id AS "moduleId", current_analysis AS "currentAnalysis",
      development_items AS "developmentItems" FROM idp_plan_analyses
      WHERE tenant_id = ${tenantId} AND plan_id = ${planId}::uuid ORDER BY module_id`),
  );
  const reviews = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT r.module_id AS "moduleId", r.stage_id AS "stageId", r.summary, r.improvement
      FROM idp_plan_reviews r JOIN idp_plan_stages s ON s.tenant_id = r.tenant_id AND s.id = r.stage_id
      WHERE r.tenant_id = ${tenantId} AND r.plan_id = ${planId}::uuid ORDER BY s.seq, r.module_id`),
  );
  return { analyses, reviews };
}

/** 关键信息（IDP-R7）：与计划起止有交集的记录；储备人才信息待 R3-T06（K-16）。 */
async function loadKeyInfo(tx: Tx, plan: PlanRow): Promise<KeyInfo> {
  const period = { startDate: plan.startDate, endDate: plan.endDate };
  const span = sql`start_date <= ${plan.endDate}::date AND (end_date IS NULL OR end_date >= ${plan.startDate}::date)`;
  const select = (columns: ReturnType<typeof sql>, table: string, person: string) =>
    tx.execute(sql`SELECT ${columns}, start_date::text AS "startDate", end_date::text AS "endDate"
      FROM ${sql.raw(table)} WHERE tenant_id = ${plan.tenantId} AND ${sql.raw(person)} = ${plan.employeeId}::uuid
        AND ${span} ORDER BY start_date, id`);
  const keep = (rows: Record<string, unknown>[]) =>
    rows.filter((r) => periodsIntersect(period, r as { startDate: string; endDate: string | null }));
  return {
    tutorships: keep(
      rowsOf(
        await select(
          sql`id, tutor_employee_id AS "tutorEmployeeId", tutee_employee_id AS "tuteeEmployeeId", remark`,
          'idp_tutorships',
          'tutee_employee_id',
        ),
      ),
    ),
    careers: keep(
      rowsOf(
        await select(
          sql`id, employee_id AS "employeeId", target_position_id AS "targetPositionId", strengths,
            development_items AS "developmentItems", intended_city AS "intendedCity"`,
          'idp_careers',
          'employee_id',
        ),
      ),
    ),
    workShifts: keep(
      rowsOf(
        await select(
          sql`id, employee_id AS "employeeId", org_id AS "orgId", position_id AS "positionId",
            post_id AS "postId", mentor_employee_id AS "mentorEmployeeId"`,
          'idp_work_shifts',
          'employee_id',
        ),
      ),
    ),
  };
}

async function templateModules(tx: Tx, tenantId: string, templateId: string) {
  const rows = await loadModuleRows(tx, tenantId, templateId);
  const nodes = await loadNodeSettings(
    tx,
    tenantId,
    rows.map((m) => m.id),
  );
  return rows.map((m) => moduleView(m, nodes.get(m.id) ?? []));
}

export async function loadPlanDetail(tx: Tx, plan: PlanRow, asOf: string): Promise<PlanDetail> {
  const stages = await loadStages(tx, plan.tenantId, [plan.id]);
  const running = stages.find((s) => s.status === 'running' && s.approvalInstanceId);
  const nodes = await currentNodes(tx, plan.tenantId, running ? [running.approvalInstanceId!] : []);
  const node = running ? nodes.get(running.approvalInstanceId!) : undefined;
  return {
    ...planRecord(plan),
    revision: plan.revision,
    status: plan.status as PlanRow['status'],
    createdBy: plan.createdBy,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    currentStageName: currentStageName(plan.status as Parameters<typeof currentStageName>[0], stages),
    currentNodeName: node?.status === 'running' ? node.nodeName : null,
    stages: await stageViews(tx, plan, stages, asOf),
    modules: await templateModules(tx, plan.tenantId, plan.templateId),
    goals: await loadGoals(tx, plan.tenantId, plan.id),
    ...(await loadContents(tx, plan.tenantId, plan.id)),
    keyInfo: await loadKeyInfo(tx, plan),
  };
}

/** HR 与参与人共用：关键信息按查看人对源对象的字段查看权裁剪，没有对象查看权不列出（DEC-309，E6）。 */
export interface Projections {
  readonly plan: Projection;
  readonly goal: Projection;
  readonly task: Projection;
  readonly goalReview: Projection;
  readonly analysis: Projection;
  readonly review: Projection;
  readonly templateModule: Projection;
  readonly tutorship: Projection;
  readonly career: Projection;
  readonly workShift: Projection;
  readonly subProcess: Projection;
  /** 阶段 dueDate 依据任职生效日时的源权限（E10）。 */
  readonly employment: StageSources['employment'];
  /** 查看人的业务日期（租户时区）。 */
  readonly asOf: string;
  /** 关键信息各对象的当前范围（与直接读取同一谓词，P2-1）。 */
  readonly keyInfoScopes: Readonly<Record<KeyInfoKind, ModuleScope>>;
}

const PROJECTED: readonly (keyof Projections & IdpObject)[] = [
  'plan',
  'goal',
  'task',
  'goalReview',
  'analysis',
  'review',
  'templateModule',
  'tutorship',
  'career',
  'workShift',
  'subProcess',
];

export async function planProjections(deps: TenantRouteDeps, ctx: IdpContext): Promise<Projections> {
  const entries = await Promise.all(PROJECTED.map(async (key) => [key, await projectionOf(deps, ctx, key)] as const));
  const scopes = await Promise.all(
    KEY_INFO_KINDS.map(async (kind) => {
      const code = codeOf(kind);
      return [kind, await resolveModuleScope(deps, ctx, undefined, code, `${code}.detail`)] as const;
    }),
  );
  const record = MODULE_OBJECTS.employmentRecord.code;
  const employment = {
    fields: (await deps.authorize({ ...ctx, action: 'object.view', resource: record, fields: [] }))
      ? await getModuleViewableFields(deps, ctx, record)
      : null,
    scope: await resolveModuleScope(deps, ctx, undefined, record, `${record}.detail`),
  };
  return {
    ...Object.fromEntries(entries),
    employment,
    asOf: tenantLocalDate(deps.clock(), ctx.timezone),
    keyInfoScopes: Object.fromEntries(scopes),
  } as unknown as Projections;
}

export const stageSourcesOf = (p: Projections): StageSources => ({
  subProcess: p.subProcess,
  plan: p.plan,
  employment: p.employment,
});

const listOf = (rows: readonly Record<string, unknown>[], projection: Projection) =>
  projection === null ? [] : rows.map((row) => project(row, projection));

/** 关键信息：记录涉及的全部员工 / 组织都在查看人范围内才列出（与直接读取一致），再按源对象字段权裁剪。 */
async function keyInfoShown(tx: Tx, info: KeyInfo, p: Projections): Promise<KeyInfo> {
  const shown = async (kind: KeyInfoKind, rows: readonly Record<string, unknown>[]) => {
    const kept: Record<string, unknown>[] = [];
    for (const row of p[kind] === null ? [] : rows)
      if (await inScope(tx, p.keyInfoScopes[kind], KEY_INFO[kind], row)) kept.push(row);
    return listOf(kept, p[kind]);
  };
  return {
    tutorships: await shown('tutorship', info.tutorships),
    careers: await shown('career', info.careers),
    workShifts: await shown('workShift', info.workShifts),
  };
}

/** 参与人固定字段集（DEC-296④）：计划不按 IDP 字段权限，模块只带结构与本节点按钮。 */
const PARTICIPANT_PLAN_KEYS = [
  'id',
  'revision',
  'name',
  'employeeId',
  'templateId',
  'startDate',
  'endDate',
  'status',
  'currentStageName',
  'currentNodeName',
  'stages',
] as const;

export async function presentPlan(
  tx: Tx,
  tenantId: string,
  detail: PlanDetail,
  viewer: PlanViewer,
  projections: Projections,
): Promise<Record<string, unknown>> {
  if (viewer.kind === 'hr') {
    const { modules, goals, analyses, reviews, keyInfo, ...top } = detail;
    const shown: Record<string, unknown> = project(top, projections.plan);
    const sources = stageSourcesOf(projections);
    if ('stages' in shown)
      shown.stages = await stagesShown(tx, { tenantId, ...detail }, detail.stages, sources, projections.asOf);
    if ('currentStageName' in shown) shown.currentStageName = currentStageShown(detail.currentStageName, sources);
    if (projections.templateModule !== null) shown.modules = modules.map((m) => project(m, projections.templateModule));
    if (projections.goal !== null) {
      // 嵌套的 tasks / reviews 本身是目标的字段（IdpGoal.tasks / reviews），先按目标字段权、再按子对象查看权（P2-3）
      const goalFields = projections.goal;
      const nested = (field: 'tasks' | 'reviews', child: Projection) =>
        child !== null && (goalFields === undefined || goalFields.has(field));
      shown.goals = goals.map(({ tasks, reviews: goalReviews, ...goal }) => ({
        ...project(goal, projections.goal),
        ...(nested('tasks', projections.task) ? { tasks: listOf(tasks, projections.task) } : {}),
        ...(nested('reviews', projections.goalReview) ? { reviews: listOf(goalReviews, projections.goalReview) } : {}),
      }));
    }
    if (projections.analysis !== null) shown.analyses = listOf(analyses, projections.analysis);
    if (projections.review !== null) shown.reviews = listOf(reviews, projections.review);
    shown.keyInfo = await keyInfoShown(tx, keyInfo, projections);
    return shown;
  }
  const { stage, nodeKey } = viewer.at;
  const buttons = stage && nodeKey ? await nodeButtons(tx, tenantId, stage, nodeKey) : new Map<string, string[]>();
  const shown: Record<string, unknown> = Object.fromEntries(PARTICIPANT_PLAN_KEYS.map((k) => [k, detail[k]]));
  shown.stages = await stagesShown(tx, { tenantId, ...detail }, detail.stages, null, projections.asOf);
  shown.modules = detail.modules.map((m) => ({
    id: m.id,
    moduleType: m.moduleType,
    name: m.name,
    displayOrder: m.displayOrder,
    buttons: [...(buttons.get(m.id) ?? [])],
  }));
  shown.goals = detail.goals;
  shown.analyses = detail.analyses;
  shown.reviews = detail.reviews;
  shown.keyInfo = await keyInfoShown(tx, detail.keyInfo, projections);
  return shown;
}
