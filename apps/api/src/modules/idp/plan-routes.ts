/**
 * R3-T07 PR-B 发展计划接口（docs/02_业务建模/28 §2.3；PR 描述矩阵第二节与路由声明表）。挂在 /api/tenant/idp/ 下：
 * - 计划 plans（HR：列表 / 详情 / 新建 / 修改 / 删除 / 开始）与参与人列表 my-plans；
 * - 执行：胜任力库候选、目标 / 任务 / 目标回顾 / 模块内容（当前节点执行人 + 节点按钮，DEC-296④ / DEC-307）；
 * - 干预：催办 / 开启下个阶段 / 终止（批量逐条回执）、跳转、统一下发任务。
 * 写入走命令台账（幂等、revision 409）；首次执行与幂等重放都按当前功能权限、按钮、范围与执行人复核，响应按查看人呈现。
 */
import { and, asc, eq, idpPlans, inArray, isUuid, sql, type Tx, withTenant } from '@italent/db';
import { currentStageName, type NodeButton, PLAN_STATUSES, type PlanStatus, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { personOfUser } from '../approval/resolver.js';
import { pageQuery, parseBody, requireNew, revision, uuidParam } from '../job/context.js';
import { scopeSql } from '../permission/module-access.js';
import { EMPTY_SCOPE } from '../permission/scope-types.js';
import {
  checkWriteFields,
  codeOf,
  idpContext,
  type IdpContext,
  idpScope,
  idpWriteContext,
  listEnvelope,
  project,
  projectionOf,
  requireReadable,
  rowsOf,
} from './access.js';
import * as execution from './execution-service.js';
import { runIdpCommand } from './executor.js';
import * as intervention from './intervention-service.js';
import { type HrScope, hrSees, requireViewer } from './plan-access.js';
import * as input from './plan-input.js';
import * as plans from './plan-service.js';
import { loadPlanRow, loadStages, type PlanRow, requirePlanRow } from './plan-store.js';
import type { WriteContext } from './write-support.js';
import {
  currentStageShown,
  loadPlanDetail,
  type PlanDetail,
  planProjections,
  presentPlan,
  type Projections,
  stageSourcesOf,
  stagesShown,
  stageViews,
} from './plan-view.js';

const BASE = '/api/tenant/idp';

export function registerPlanRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerPlanReads(router, deps);
  registerPlanWrites(router, deps);
  registerGoalRoutes(router, deps);
  registerContentRoutes(router, deps);
  registerInterventions(router, deps);
}

// ---- 上下文与执行器 ----

/** 参与人入口不要求 IDP 对象权限（本人 / 指导人 / 待办人没有 IDP 身份），权限在服务层按关系与节点按钮判定。 */
function baseContext(c: Context<TenantEnv>, deps: TenantRouteDeps, expectedRevision = 0): IdpContext {
  return { ...tenantOf(c), expectedRevision, now: deps.clock(), commandId: '' };
}

/** HR 范围：持 IDP.Idp 查看权时按（用户 × IDP）解析，否则为 null（只按参与关系）。 */
async function hrScopeOf(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: IdpContext): Promise<HrScope> {
  const can = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf('plan'), fields: [] });
  return can ? idpScope(c, deps, ctx, 'plan') : null;
}

/** 计划侧命令的范围与上下文：HR 范围（可为 null，只按参与关系）随写上下文传给服务层。 */
const planCommand = (hr: HrScope) => ({
  scope: hr ?? EMPTY_SCOPE,
  extend: (w: WriteContext): plans.PlanWriteContext => ({ ...w, hr }),
});

/** 按查看人呈现计划当前状态（HR 字段裁剪 / 参与人固定字段集）。 */
async function showPlan(deps: TenantRouteDeps, ctx: IdpContext, hr: HrScope, planId: string) {
  const projections = await planProjections(deps, ctx);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const plan = await requirePlanRow(tx, ctx.tenantId, planId);
    const viewer = await requireViewer(tx, ctx, hr, plan, await loadStages(tx, ctx.tenantId, [planId]));
    const detail = await loadPlanDetail(tx, plan, tenantLocalDate(ctx.now, ctx.timezone));
    return { revision: plan.revision, body: await presentPlan(tx, ctx.tenantId, detail, viewer, projections) };
  });
}

async function respondPlan(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: IdpContext,
  hr: HrScope,
  id: string,
  status: 200 | 201,
) {
  const shown = await showPlan(deps, ctx, hr, id);
  c.header('ETag', `"${shown.revision}"`);
  return c.json(shown.body, status);
}

/** 写入后计划仍在、HR 仍看得到（范围外 / 已不存在 404）。 */
async function stillVisible(tx: Tx, ctx: IdpContext, hr: HrScope, planId: string) {
  const plan = await loadPlanRow(tx, ctx.tenantId, planId);
  if (!plan || !(await hrSees(tx, hr, plan))) throw new AppError('NOT_FOUND', '发展计划不存在');
}

// ---- 读取 ----

/** 列表摘要；projections 为 HR 的阶段带出源权限（E9 / E10，含所属流程范围 R2-4），参与人列表按固定字段集传 null。 */
async function summaries(tx: Tx, tenantId: string, rows: PlanRow[], asOf: string, projections: Projections | null) {
  const stages = await loadStages(
    tx,
    tenantId,
    rows.map((r) => r.id),
  );
  return Promise.all(
    rows.map(async (row) => {
      const own = stages.filter((s) => s.planId === row.id);
      const sources = projections && (await stageSourcesOf(tx, projections, row));
      const detail = await stagesShown(tx, row, await stageViews(tx, row, own, asOf), sources, asOf);
      return {
        id: row.id,
        revision: row.revision,
        name: row.name,
        employeeId: row.employeeId,
        templateId: row.templateId,
        processId: row.processId,
        startDate: row.startDate,
        endDate: row.endDate,
        tutorRole: row.tutorRole,
        tutorEmployeeId: row.tutorEmployeeId,
        status: row.status,
        currentStageName: currentStageShown(currentStageName(row.status as PlanStatus, own), sources),
        stages: detail,
      };
    }),
  );
}

function statusQuery(c: Context) {
  const value = c.req.query('status');
  if (value === undefined || value === '') return undefined;
  if (!(PLAN_STATUSES as readonly string[]).includes(value)) throw new AppError('VALIDATION_FAILED', 'status 不合法');
  return value;
}

function registerPlanReads(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${BASE}/plans`, async (c) => {
    const ctx = await idpContext(c, deps, 'plan');
    const scope = await idpScope(c, deps, ctx, 'plan');
    const page = pageQuery(c);
    const status = statusQuery(c);
    const projections = await planProjections(deps, ctx);
    const top = projections.plan;
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(idpPlans)
        .where(
          and(
            eq(idpPlans.tenantId, ctx.tenantId),
            status === undefined ? undefined : eq(idpPlans.status, status),
            sql`${scopeSql(scope, { person: sql`${idpPlans.employeeId}` })}`,
          ),
        )
        .orderBy(asc(idpPlans.createdAt), asc(idpPlans.id))
        .limit(page.limit)
        .offset(page.offset);
      return summaries(tx, ctx.tenantId, rows, projections.asOf, projections);
    });
    return c.json({ ...listEnvelope(page, scope), items: items.map((item) => project(item, top)) });
  });

  /** 参与人列表（K-30～K-32）：本人 / 指导人的非未开始计划，以及当前有待办的计划；固定字段。 */
  router.get(`${BASE}/my-plans`, async (c) => {
    const ctx = baseContext(c, deps);
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const me = await personOfUser(tx, ctx.tenantId, ctx.userId);
      const ids = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT p.id FROM idp_plans p WHERE p.tenant_id = ${ctx.tenantId} AND (
          (p.status <> 'not_started' AND ${me}::uuid IS NOT NULL
            AND (p.employee_id = ${me}::uuid OR p.tutor_employee_id = ${me}::uuid))
          OR EXISTS (SELECT 1 FROM idp_plan_stages s JOIN approval_tasks t ON t.tenant_id = s.tenant_id
            AND t.instance_id = s.approval_instance_id
            WHERE s.tenant_id = p.tenant_id AND s.plan_id = p.id AND s.status = 'running' AND t.status = 'pending'
              AND t.assignee_user_id = ${ctx.userId}::uuid))
          ORDER BY p.created_at, p.id LIMIT ${page.limit} OFFSET ${page.offset}`),
      ).map((r) => r.id);
      if (!ids.length) return [];
      const rows = await tx
        .select()
        .from(idpPlans)
        .where(and(eq(idpPlans.tenantId, ctx.tenantId), inArray(idpPlans.id, ids)))
        .orderBy(asc(idpPlans.createdAt), asc(idpPlans.id));
      const shown = await summaries(tx, ctx.tenantId, rows, tenantLocalDate(ctx.now, ctx.timezone), null);
      return shown.map(({ tutorRole: _r, tutorEmployeeId: _t, processId: _p, ...rest }) => rest);
    });
    return c.json({ page: page.page, pageSize: page.pageSize, items });
  });

  router.get(`${BASE}/plans/:id`, async (c) => {
    const ctx = baseContext(c, deps);
    const id = uuidParam(c);
    return respondPlan(c, deps, ctx, await hrScopeOf(c, deps, ctx), id, 200);
  });
}

// ---- HR 写入 ----

/** 新建计划所选模板须对操作人可见（自有或向下公开，与 PR-A 选用流程同口径）。 */
async function templateCheck(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: IdpContext) {
  const can = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf('template'), fields: [] });
  if (!can) throw new AppError('FORBIDDEN', '无权查看发展计划模板');
  const scope = await idpScope(c, deps, ctx, 'template');
  return async (tx: Tx, templateId: string) => {
    const [row] = rowsOf<{ org_id: string; public_down: boolean; created_by: string }>(
      await tx.execute(sql`SELECT org_id, public_down, created_by FROM idp_templates
        WHERE tenant_id = ${ctx.tenantId} AND id = ${templateId}::uuid`),
    );
    if (!row) throw new AppError('NOT_FOUND', '发展计划模板不存在');
    await requireReadable(tx, ctx, scope, 'template', {
      orgId: row.org_id,
      publicDown: row.public_down,
      createdBy: row.created_by,
    });
  };
}

function registerPlanWrites(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(`${BASE}/plans`, async (c) => {
    const ctx = await idpWriteContext(c, deps, 'plan', 'create', 'create', 'list', revision(c));
    requireNew(ctx);
    const body = await parseBody(c, input.planCreate);
    await checkWriteFields(deps, ctx, 'plan', 'create', body);
    const hr = await idpScope(c, deps, ctx, 'plan');
    const visibleTemplate = await templateCheck(c, deps, ctx);
    const sources = await plans.carrySources(deps, ctx, await projectionOf(deps, ctx, 'commonGoal'));
    const { view, status } = await runIdpCommand<PlanDetail, plans.PlanWriteContext>(c, deps, ctx, {
      ...planCommand(hr),
      status: 201,
      body,
      execute: async (tx, w) => {
        await visibleTemplate(tx, body.templateId);
        return plans.createPlan(tx, w, sources, body);
      },
      recheck: (tx, _scope, plan) => stillVisible(tx, ctx, hr, plan.id),
    });
    return respondPlan(c, deps, ctx, hr, view.id, status as 201);
  });

  router.patch(`${BASE}/plans/:id`, async (c) => {
    const ctx = await idpWriteContext(c, deps, 'plan', 'update', 'update', 'detail', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.planPatch);
    await checkWriteFields(deps, ctx, 'plan', 'update', body);
    const hr = await idpScope(c, deps, ctx, 'plan');
    const sources = await plans.carrySources(deps, ctx, null);
    await runIdpCommand<PlanDetail, plans.PlanWriteContext>(c, deps, ctx, {
      ...planCommand(hr),
      status: 200,
      body,
      execute: (tx, w) => plans.updatePlan(tx, w, sources, id, body),
      recheck: (tx) => stillVisible(tx, ctx, hr, id),
    });
    return respondPlan(c, deps, ctx, hr, id, 200);
  });

  router.post(`${BASE}/plans/:id/start`, async (c) => {
    const ctx = await idpWriteContext(c, deps, 'plan', 'update', 'start', 'detail', revision(c));
    const id = uuidParam(c);
    const hr = await idpScope(c, deps, ctx, 'plan');
    await runIdpCommand<PlanDetail, plans.PlanWriteContext>(c, deps, ctx, {
      ...planCommand(hr),
      status: 200,
      body: { id, action: 'start' },
      execute: (tx, w) => plans.startPlan(tx, w, id),
      recheck: (tx) => stillVisible(tx, ctx, hr, id),
    });
    return respondPlan(c, deps, ctx, hr, id, 200);
  });

  router.delete(`${BASE}/plans/:id`, async (c) => {
    const ctx = await idpWriteContext(c, deps, 'plan', 'delete', 'delete', 'detail', revision(c));
    const id = uuidParam(c);
    const hr = await idpScope(c, deps, ctx, 'plan');
    const projections = await planProjections(deps, ctx);
    const { view } = await runIdpCommand<PlanDetail, plans.PlanWriteContext>(c, deps, ctx, {
      ...planCommand(hr),
      status: 200,
      body: { id },
      execute: (tx, w) => plans.deletePlan(tx, deps, w, id),
      // 删除的受控快照：按删除时的员工归属复核当前范围
      recheck: async (tx, _scope, snapshot) => {
        if (!(await hrSees(tx, hr, snapshot))) throw new AppError('NOT_FOUND', '发展计划不存在');
      },
    });
    const body = await withTenant(deps.db, ctx.tenantId, (tx) =>
      presentPlan(tx, ctx.tenantId, view, { kind: 'hr' }, projections),
    );
    return c.json(body, 200);
  });
}

// ---- 执行人写入（DEC-296④） ----

interface ExecResult {
  readonly planId: string;
  readonly moduleId: string;
  readonly button: NodeButton | readonly NodeButton[];
}

/** 执行人写入：计划 revision 校验在服务层；首次与重放返回前都按当前节点复核执行人与按钮。 */
async function runExecutorWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  status: 200 | 201,
  body: unknown,
  execute: (tx: Tx, w: plans.PlanWriteContext) => Promise<ExecResult>,
) {
  const ctx = baseContext(c, deps, revision(c));
  const hr = await hrScopeOf(c, deps, ctx);
  const { view } = await runIdpCommand<ExecResult, plans.PlanWriteContext>(c, deps, ctx, {
    ...planCommand(hr),
    status,
    body,
    execute,
    recheck: (tx, _scope, r) =>
      execution.recheckExecutor(tx, { ...ctx, scope: EMPTY_SCOPE, checks: [], hr }, r.planId, r.moduleId, r.button),
  });
  return respondPlan(c, deps, ctx, hr, view.planId, status);
}

/**
 * 目标所在模块。先判计划可见（HR 或参与人，否则 404“发展计划不存在”），再找目标：看不到计划的人拿不到“目标是否存在”的
 * 区别（响应一致）。
 */
async function goalModule(tx: Tx, w: plans.PlanWriteContext, planId: string, goalId: string) {
  const plan = await loadPlanRow(tx, w.tenantId, planId);
  if (!plan) throw new AppError('NOT_FOUND', '发展计划不存在');
  await requireViewer(tx, w, w.hr, plan, await loadStages(tx, w.tenantId, [planId]));
  const [row] = rowsOf<{ module_id: string }>(
    await tx.execute(sql`SELECT module_id FROM idp_goals WHERE tenant_id = ${w.tenantId} AND plan_id = ${planId}::uuid
      AND id = ${goalId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '发展目标不存在');
  return row.module_id;
}

function registerGoalRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/plans/:id`;
  router.get(`${path}/competency-candidates`, async (c) => {
    const ctx = baseContext(c, deps);
    const id = uuidParam(c);
    const moduleId = c.req.query('moduleId') ?? '';
    if (!isUuid(moduleId)) throw new AppError('VALIDATION_FAILED', 'moduleId 必须为 UUID');
    const hr = await hrScopeOf(c, deps, ctx);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      execution.candidates(tx, { ...ctx, scope: EMPTY_SCOPE, checks: [], hr }, id, moduleId.toLowerCase()),
    );
    return c.json({ items });
  });

  router.post(`${path}/goals`, async (c) => {
    const id = uuidParam(c);
    const body = await parseBody(c, input.goalCreate);
    return runExecutorWrite(c, deps, 201, body, async (tx, w) => {
      await execution.addGoal(tx, w, id, body);
      return { planId: id, moduleId: body.moduleId, button: 'RowAddIdpGoal' };
    });
  });

  router.patch(`${path}/goals/:goalId`, async (c) => {
    const id = uuidParam(c);
    const goalId = uuidParam(c, 'goalId');
    const body = await parseBody(c, input.goalPatch);
    return runExecutorWrite(c, deps, 200, { goalId, body }, async (tx, w) => {
      const moduleId = await goalModule(tx, w, id, goalId);
      await execution.updateGoal(tx, w, id, goalId, body);
      return { planId: id, moduleId, button: 'RowEditIdpGoal' };
    });
  });

  router.delete(`${path}/goals/:goalId`, async (c) => {
    const id = uuidParam(c);
    const goalId = uuidParam(c, 'goalId');
    return runExecutorWrite(c, deps, 200, { goalId }, async (tx, w) => {
      const moduleId = await goalModule(tx, w, id, goalId);
      await execution.deleteGoal(tx, w, id, goalId);
      return { planId: id, moduleId, button: execution.GOAL_DELETE_BUTTONS };
    });
  });
}

function registerContentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const path = `${BASE}/plans/:id/goals/:goalId`;
  const ids = (c: Context<TenantEnv>) => ({ planId: uuidParam(c), goalId: uuidParam(c, 'goalId') });
  const edit = (planId: string, moduleId: string): ExecResult => ({ planId, moduleId, button: 'RowEditIdpGoal' });

  router.post(`${path}/tasks`, async (c) => {
    const { planId, goalId } = ids(c);
    const body = await parseBody(c, input.taskCreate);
    return runExecutorWrite(c, deps, 201, { goalId, body }, async (tx, w) => {
      const moduleId = await goalModule(tx, w, planId, goalId);
      await execution.addTask(tx, w, planId, goalId, body);
      return edit(planId, moduleId);
    });
  });

  router.patch(`${path}/tasks/:taskId`, async (c) => {
    const { planId, goalId } = ids(c);
    const taskId = uuidParam(c, 'taskId');
    const body = await parseBody(c, input.taskPatch);
    return runExecutorWrite(c, deps, 200, { goalId, taskId, body }, async (tx, w) => {
      const moduleId = await goalModule(tx, w, planId, goalId);
      await execution.updateTask(tx, w, { planId, goalId, taskId }, body);
      return edit(planId, moduleId);
    });
  });

  router.delete(`${path}/tasks/:taskId`, async (c) => {
    const { planId, goalId } = ids(c);
    const taskId = uuidParam(c, 'taskId');
    return runExecutorWrite(c, deps, 200, { goalId, taskId }, async (tx, w) => {
      const moduleId = await goalModule(tx, w, planId, goalId);
      await execution.deleteTask(tx, w, { planId, goalId, taskId });
      return edit(planId, moduleId);
    });
  });

  router.put(`${path}/review`, async (c) => {
    const { planId, goalId } = ids(c);
    const body = await parseBody(c, input.goalReview);
    return runExecutorWrite(c, deps, 200, { goalId, body }, async (tx, w) => {
      const moduleId = await goalModule(tx, w, planId, goalId);
      await execution.saveGoalReview(tx, w, planId, goalId, body);
      return edit(planId, moduleId);
    });
  });

  router.put(`${BASE}/plans/:id/modules/:moduleId/content`, async (c) => {
    const planId = uuidParam(c);
    const moduleId = uuidParam(c, 'moduleId');
    const body = await parseBody(c, input.moduleContent);
    return runExecutorWrite(c, deps, 200, { moduleId, body }, async (tx, w) => {
      await execution.saveModuleContent(tx, w, planId, moduleId, body);
      return { planId, moduleId, button: 'EditModuleContent' };
    });
  });
}

// ---- 干预与统一下发 ----

/**
 * 批量回执：首次与重放都按当前范围逐条复核——成功与失败的回执一样，计划已不在范围内（或已不存在）就改成 404，
 * 不再回放业务错误（P2-6）。原本就是 404 的保持不变。
 */
async function receiptsNow(tx: Tx, ctx: IdpContext, hr: HrScope, receipts: readonly intervention.Receipt[]) {
  const shown: intervention.Receipt[] = [];
  for (const receipt of receipts) {
    const plan = await loadPlanRow(tx, ctx.tenantId, receipt.id);
    const visible = plan !== undefined && (await hrSees(tx, hr, plan));
    shown.push(visible ? receipt : { id: receipt.id, status: 404, code: 'NOT_FOUND' });
  }
  return shown;
}

function registerInterventions(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  const batches = [
    ['urge', 'urge', input.batchItems, intervention.urgePlans],
    ['start-next', 'startNext', input.startNext, intervention.startNextStages],
    ['terminate', 'terminate', input.batchItems, intervention.terminatePlans],
  ] as const;
  for (const [path, buttonCode, schema, act] of batches) {
    router.post(`${BASE}/plans/${path}`, async (c) => {
      const ctx = await idpWriteContext(c, deps, 'plan', 'update', buttonCode, 'list', revision(c));
      requireNew(ctx);
      const body = await parseBody(c, schema as typeof input.startNext);
      const hr = await idpScope(c, deps, ctx, 'plan');
      const { view } = await runIdpCommand<intervention.Receipt[], plans.PlanWriteContext>(c, deps, ctx, {
        ...planCommand(hr),
        status: 200,
        body,
        execute: (tx, w) => (act as typeof intervention.startNextStages)(tx, w, body),
        recheck: async () => {},
      });
      const receipts = await withTenant(deps.db, ctx.tenantId, (tx) => receiptsNow(tx, ctx, hr, view));
      return c.json({ receipts });
    });
  }

  router.post(`${BASE}/plans/:id/jump`, async (c) => {
    const ctx = await idpWriteContext(c, deps, 'plan', 'update', 'jump', 'detail', revision(c));
    const id = uuidParam(c);
    const body = await parseBody(c, input.jump);
    const hr = await idpScope(c, deps, ctx, 'plan');
    await runIdpCommand<PlanDetail, plans.PlanWriteContext>(c, deps, ctx, {
      ...planCommand(hr),
      status: 200,
      body,
      execute: (tx, w) => intervention.jumpPlan(tx, w, id, body),
      recheck: (tx) => stillVisible(tx, ctx, hr, id),
    });
    return respondPlan(c, deps, ctx, hr, id, 200);
  });

  router.post(`${BASE}/plans/tasks/issue`, async (c) => {
    const ctx = await idpWriteContext(c, deps, 'task', 'create', 'issue', 'list', revision(c));
    requireNew(ctx);
    const body = await parseBody(c, input.taskIssue);
    await checkWriteFields(deps, ctx, 'task', 'create', body.task);
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf('plan'), fields: [] });
    if (!canView) throw new AppError('FORBIDDEN', '无权查看发展计划');
    const hr = await idpScope(c, deps, ctx, 'plan');
    const sources: intervention.IssueSources = {
      template: await projectionOf(deps, ctx, 'template'),
      commonGoal: await projectionOf(deps, ctx, 'commonGoal'),
      goal: await projectionOf(deps, ctx, 'goal'),
      templateScope: await idpScope(c, deps, ctx, 'template'),
    };
    type Issued = { created: { planId: string }[] };
    const { view, status } = await runIdpCommand<Issued, plans.PlanWriteContext>(c, deps, ctx, {
      ...planCommand(hr),
      status: 201,
      body,
      execute: (tx, w) => intervention.issueTasks(tx, w, body, sources),
      recheck: async (tx, _scope, result) => {
        for (const item of result.created) await stillVisible(tx, ctx, hr, item.planId);
      },
    });
    return c.json(view, status as 201);
  });
}
