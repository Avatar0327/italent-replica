/**
 * HR 流程干预与统一下发任务（docs/02_业务建模/28 IDP-R15 / R16；Q-M0-115 ⑥ 只读结论 🟡；PR 描述 K-42～K-46）。
 * - 催办 / 开启下个阶段 / 终止：勾选多个计划，逐条回执（部分成功；每条在自己的保存点里执行，失败的一条不影响其他）；
 *   每条复核范围（范围外回执 404）、revision（409）；本人为计划员工的计划不能干预（DEC-092）；
 * - 跳转：单个计划，只能跳到当前运行阶段审批流程版本里的节点（跨阶段 409 IDP_JUMP_CROSS_STAGE，AC-IDP-02），经审批中心的
 *   管理员跳转执行（须填原因，不代签 DEC-063）；
 * - 转交（F-066，IDP-R16）：单个计划，把当前运行阶段审批实例的当前待办转给他人，经审批中心的管理员转交执行，
 *   目标须在操作人的 IDP 范围内（本入口先校验，范围外 404）；目标其余校验（有效成员、冻结主体、同节点其他办理人）与本人回避由 adminAct 判定；
 * - 统一下发任务：勾选的计划须使用同一模板（AC-IDP-06），整体成功或整体失败。
 * 取锁顺序：计划（按 ID 升序）→ 审批实例。
 */
import { sql, type Tx } from '@italent/db';
import { type IdpObject, nextOpenableStage, tenantLocalDate } from '@italent/domain';
import { AppError, ERROR_STATUS } from '../../errors.js';
import { adminAct, urgeAsAdmin } from '../approval/actions.js';
import type { ApprovalContext } from '../approval/context.js';
import { personOfUser } from '../approval/resolver.js';
import { loadTasks } from '../approval/store.js';
import { accessOf, type ModuleScope, type Projection, rowsOf, viewable } from './access.js';
import { insertTask } from './execution-service.js';
import { employeeInScope, hrSees } from './plan-access.js';
import type { BatchItems, JumpInput, StartNextInput, TaskIssue, TransferInput } from './plan-input.js';
import { lockPlanForHr, type PlanWriteContext } from './plan-service.js';
import { bumpPlan, loadPlanRow, loadStages, type PlanRow, requirePlanRow } from './plan-store.js';
import { loadPlanDetail } from './plan-view.js';
import { cancelStageInstance, endRunningStage, openStage, type StageActor } from './stage-service.js';
import { audit, conflict, invalid } from './write-support.js';

export interface Receipt {
  readonly id: string;
  readonly status: number;
  readonly outcome?: 'urged' | 'opened' | 'skipped' | 'failed' | 'terminated';
  readonly code?: string;
}

const hrApproval = (ctx: PlanWriteContext, expectedRevision = 0): ApprovalContext => ({
  tenantId: ctx.tenantId,
  userId: ctx.userId,
  timezone: ctx.timezone,
  now: ctx.now,
  commandId: ctx.commandId,
  expectedRevision,
});

const actorOf = (ctx: PlanWriteContext): StageActor => ({ ...ctx });

/**
 * 流程干预的审计（DEC-321）：计划所有者可全量干预（DEC-092“本人发起”回避的例外），每次干预都在计划上记一条：
 * 操作人（审计行的 actor）、计划、动作、原因。前后值只用计划对象登记的字段（`intervention` / `reason` / `stageId` /
 * `toNodeKey` / `status`），审计按字段查看权展示（第 4 轮 R3-2）。
 */
async function auditIntervention(
  tx: Tx,
  ctx: PlanWriteContext,
  plan: PlanRow,
  intervention: 'urge' | 'jump' | 'transfer' | 'terminate',
  change: { readonly before: Record<string, unknown>; readonly after: Record<string, unknown>; reason: string | null },
) {
  await audit(tx, ctx, 'plan', 'update', plan.id, {
    before: change.before,
    after: { ...change.after, intervention, reason: change.reason },
    employeeId: plan.employeeId,
  });
}

/** DEC-092：不能干预本人为计划员工的计划，须由其他 HR 处理。 */
async function notOwnPlan(tx: Tx, ctx: PlanWriteContext, plan: PlanRow): Promise<void> {
  if ((await personOfUser(tx, ctx.tenantId, ctx.userId)) === plan.employeeId) {
    throw new AppError('FORBIDDEN', '不能干预本人的发展计划，请由其他管理员处理', { reason: 'IDP_INTERVENE_SELF' });
  }
}

const notActive = () => conflict('IDP_PLAN_NOT_ACTIVE', '计划未开始、已结束或已终止');

function receiptOf(id: string, error: AppError): Receipt {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  return { id, status: ERROR_STATUS[error.code], code: reason ?? error.code };
}

/** 逐条执行：每条锁计划、复核范围与 revision，失败只回执这一条（保存点回滚）。 */
async function eachPlan(
  tx: Tx,
  ctx: PlanWriteContext,
  input: BatchItems | StartNextInput,
  act: (tx: Tx, plan: PlanRow) => Promise<Receipt>,
): Promise<Receipt[]> {
  const receipts = new Map<string, Receipt>();
  for (const item of [...input.items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    try {
      receipts.set(
        item.id,
        await tx.transaction(async (sp) => {
          const plan = await loadPlanRow(sp, ctx.tenantId, item.id, true);
          if (!plan || !(await hrSees(sp, ctx.hr, plan))) throw new AppError('NOT_FOUND', '发展计划不存在');
          if (plan.revision !== item.revision) throw new AppError('REVISION_CONFLICT', '发展计划已变更，请刷新后重提');
          await notOwnPlan(sp, ctx, plan);
          return act(sp, plan);
        }),
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      receipts.set(item.id, receiptOf(item.id, error));
    }
  }
  return input.items.map((item) => receipts.get(item.id)!);
}

async function runningStage(tx: Tx, plan: PlanRow) {
  if (plan.status !== 'running') return undefined;
  return (await loadStages(tx, plan.tenantId, [plan.id])).find((s) => s.status === 'running' && s.approvalInstanceId);
}

export function urgePlans(tx: Tx, ctx: PlanWriteContext, input: BatchItems) {
  return eachPlan(tx, ctx, input, async (sp, plan) => {
    const stage = await runningStage(sp, plan);
    if (!stage) conflict('IDP_NO_RUNNING_STAGE', '计划没有进行中的阶段，无需催办');
    await urgeAsAdmin(sp, hrApproval(ctx), stage.approvalInstanceId!);
    await auditIntervention(sp, ctx, plan, 'urge', {
      before: { stageId: stage.id },
      after: { stageId: stage.id },
      reason: input.reason ?? null,
    });
    return { id: plan.id, status: 200, outcome: 'urged' };
  });
}

/**
 * 开启下个阶段（K-42，StartNextSubProcessType）：有进行中阶段时 skipRunning 不处理该计划、endRunning 先结束当前阶段；
 * 下一个待开启 / 开启失败的阶段（自动开启的可提前手动开启，IDP-R4）。开启失败照样记次数与原因并回执 409。
 */
export function startNextStages(tx: Tx, ctx: PlanWriteContext, input: StartNextInput) {
  return eachPlan(tx, ctx, input, async (sp, plan): Promise<Receipt> => {
    if (plan.status !== 'running') notActive();
    const stages = await loadStages(sp, ctx.tenantId, [plan.id]);
    const running = stages.find((s) => s.status === 'running');
    if (running && input.runningMode === 'skipRunning') return { id: plan.id, status: 200, outcome: 'skipped' };
    const next = nextOpenableStage(running ? stages.filter((s) => s.seq > running.seq) : stages);
    if (!next) conflict('IDP_NO_NEXT_STAGE', '已是最后一个阶段，没有可开启的下一阶段');
    if (running) await endRunningStage(sp, actorOf(ctx), plan, running);
    const outcome = await openStage(sp, actorOf(ctx), await requirePlanRow(sp, ctx.tenantId, plan.id), next);
    if (outcome.kind === 'opened') return { id: plan.id, status: 200, outcome: 'opened' };
    return { id: plan.id, status: 409, outcome: 'failed', code: outcome.reason };
  });
}

/** 终止（K-45）：未开始 / 进行中 → 已终止；运行中的审批实例作废；终态。 */
export function terminatePlans(tx: Tx, ctx: PlanWriteContext, input: BatchItems) {
  return eachPlan(tx, ctx, input, async (sp, plan): Promise<Receipt> => {
    if (plan.status !== 'running' && plan.status !== 'not_started') notActive();
    for (const stage of await loadStages(sp, ctx.tenantId, [plan.id])) {
      if (stage.status === 'running') await cancelStageInstance(sp, actorOf(ctx), plan, stage);
    }
    await sp.execute(sql`UPDATE idp_plans SET status = 'terminated', revision = revision + 1,
      updated_at = ${ctx.now.toISOString()} WHERE tenant_id = ${ctx.tenantId} AND id = ${plan.id}::uuid`);
    await auditIntervention(sp, ctx, plan, 'terminate', {
      before: { status: plan.status },
      after: { status: 'terminated' },
      reason: input.reason ?? null,
    });
    return { id: plan.id, status: 200, outcome: 'terminated' };
  });
}

/** 单个计划的干预入口共用：当前运行阶段及其进行中的审批实例（没有则 409 IDP_NO_RUNNING_STAGE）。 */
async function runningInstance(tx: Tx, ctx: PlanWriteContext, plan: PlanRow) {
  const stage = await runningStage(tx, plan);
  if (!stage) conflict('IDP_NO_RUNNING_STAGE', '计划没有进行中的阶段');
  const [instance] = rowsOf<{ revision: number; version_id: string; status: string }>(
    await tx.execute(sql`SELECT revision, version_id, status FROM approval_instances
      WHERE tenant_id = ${ctx.tenantId} AND id = ${stage.approvalInstanceId}::uuid`),
  );
  if (instance?.status !== 'running') conflict('IDP_NO_RUNNING_STAGE', '计划没有进行中的阶段');
  return { stage, instance };
}

/** 跳转（K-43）：只能在当前运行阶段的审批流程版本内跳（AC-IDP-02）。 */
export async function jumpPlan(tx: Tx, ctx: PlanWriteContext, planId: string, input: JumpInput) {
  const plan = await lockPlanForHr(tx, ctx, planId);
  // F-048 §6 #20：本人回避不在这里查实时绑定，由 adminAct 按发起 / 重提时冻结的 U(S) 判定（I′：所有者豁免，主体回避）；
  // 冻结之后才首次绑定到该员工的所有者本轮不追溯（DEC-329⑤）。催办、终止、开启下一阶段仍用 notOwnPlan。
  const { stage, instance } = await runningInstance(tx, ctx, plan);
  const nodes = rowsOf<{ node_key: string }>(
    await tx.execute(sql`SELECT node_key FROM approval_process_nodes WHERE tenant_id = ${ctx.tenantId}
      AND version_id = ${instance.version_id}::uuid`),
  );
  const crossStage = input.stageId !== undefined && input.stageId !== stage.id;
  if (crossStage || !nodes.some((n) => n.node_key === input.toNodeKey)) {
    conflict('IDP_JUMP_CROSS_STAGE', '只能在当前子流程内跳转，不能跨阶段');
  }
  await adminAct(
    tx,
    hrApproval(ctx, Number(instance.revision)),
    { instanceId: stage.approvalInstanceId!, kind: 'jump', toNodeKey: input.toNodeKey, reason: input.reason },
    sql`true`,
    // DEC-321：计划所有者（审批发起人）可干预本计划，不按 DEC-092“本人发起”回避；“本人为计划员工”仍回避
    { ownerIntervention: true },
  );
  await bumpPlan(tx, ctx.tenantId, plan.id, ctx.now);
  await auditIntervention(tx, ctx, plan, 'jump', {
    before: { stageId: stage.id, toNodeKey: null },
    after: { stageId: stage.id, toNodeKey: input.toNodeKey },
    reason: input.reason,
  });
  return loadPlanDetail(tx, await requirePlanRow(tx, ctx.tenantId, plan.id), tenantLocalDate(ctx.now, ctx.timezone));
}

/**
 * 转交目标须是已绑定员工、且在操作人的 IDP 范围内（IDP-R16“受管理单元限制”；引用 ID 写入前校验范围）。账号不存在、
 * 未绑定员工的纯账号（先按拒绝，待产品确认）、范围外三种情况同一个 404，不暴露存在性。
 */
async function requireTargetInScope(tx: Tx, ctx: PlanWriteContext, toUserId: string): Promise<void> {
  const employeeId = await personOfUser(tx, ctx.tenantId, toUserId);
  if (employeeId === null || !(await employeeInScope(tx, ctx.hr, employeeId))) {
    throw new AppError('NOT_FOUND', '转交目标不存在');
  }
}

/**
 * 转交（F-066，IDP-R16）：把当前运行阶段审批实例的当前待办转给 `toUserId`，撤回原待办、给新人发待办。
 * 本人回避同跳转（F-048 §6 #17 / #20，DEC-321）：不查实时绑定，由 adminAct 按冻结的 U(S) 判定；转交目标的有效性、
 * 是否在冻结主体集合内也都由 adminAct 判定，这里不另写一套；adminAct 不看操作人范围，目标在范围内由本入口先校验。未指定 taskId 时只在恰有一条待办时取它。
 * 计划审计只记计划对象登记的字段；新旧审批人写在审批实例的 `approval.admin.transfer` 审计里（DEC-063）。
 */
export async function transferPlan(tx: Tx, ctx: PlanWriteContext, planId: string, input: TransferInput) {
  const plan = await lockPlanForHr(tx, ctx, planId);
  await requireTargetInScope(tx, ctx, input.toUserId);
  const { stage, instance } = await runningInstance(tx, ctx, plan);
  const instanceId = stage.approvalInstanceId!;
  const pending = (await loadTasks(tx, ctx.tenantId, instanceId)).filter((t) => t.status === 'pending');
  if (input.taskId === undefined && pending.length > 1) {
    invalid('当前阶段有多条待办，请指定要转交的待办', { reason: 'IDP_TRANSFER_TASK_REQUIRED' });
  }
  const taskId = input.taskId ?? pending[0]?.id;
  await adminAct(
    tx,
    hrApproval(ctx, Number(instance.revision)),
    {
      instanceId,
      kind: 'transfer',
      toUserId: input.toUserId,
      reason: input.reason ?? null,
      ...(taskId ? { taskId } : {}),
    },
    sql`true`,
    // 目标已由上面的 requireTargetInScope 按 IDP 范围校验（F-066）
    { ownerIntervention: true, targetChecked: true },
  );
  await bumpPlan(tx, ctx.tenantId, plan.id, ctx.now);
  await auditIntervention(tx, ctx, plan, 'transfer', {
    before: { stageId: stage.id },
    after: { stageId: stage.id },
    reason: input.reason ?? null,
  });
  return loadPlanDetail(tx, await requirePlanRow(tx, ctx.tenantId, plan.id), tenantLocalDate(ctx.now, ctx.timezone));
}

/** 统一下发的源对象查看权（事务外按当前权限解析，P2-5 / R2-5）。 */
export interface IssueSources {
  readonly template: Projection;
  readonly templateModule: Projection;
  readonly commonGoal: Projection;
  readonly goal: Projection;
  readonly plan: Projection;
  readonly templateScope: ModuleScope;
}

/**
 * 统一下发实际用到的源字段（第 3 轮 R2-5）：通用目标 → 所属模块（moduleId）→ 模块开关 taskEnabled；计划的 templateId
 * 用于“模板一致”判定；目标的 commonGoalId 用于找到要挂任务的目标。看不到任一项与“通用目标不存在”同一个 404。
 */
const ISSUE_SOURCE_FIELDS: readonly (readonly [keyof IssueSources & IdpObject, readonly string[]])[] = [
  ['template', []],
  ['templateModule', ['taskEnabled']],
  ['commonGoal', ['moduleId']],
  ['goal', ['commonGoalId']],
  ['plan', ['templateId']],
];

const hiddenGoal = () => new AppError('NOT_FOUND', '模板通用目标不存在');

/**
 * 统一下发任务（K-46，IDP-R15）：按模板通用目标下发，勾选的计划须使用同一模板（409 IDP_TASK_TEMPLATE_MISMATCH）；
 * 每个计划由该通用目标生成的目标下各加一条任务，整体成功或整体失败。范围 / revision 先于模板判定。
 * 通用目标与目标是“从另一个对象带出值”（入口清单 E11）：先判操作人对实际用到的源对象与字段的查看权（模板另须在
 * 范围内），看不到时“不存在 / 模板不一致 / 任务关闭 / 目标缺失”都是同一个 404，回执不含隐藏目标（P2-5 / R2-5）。
 */
export async function issueTasks(tx: Tx, ctx: PlanWriteContext, input: TaskIssue, sources: IssueSources) {
  const plans: PlanRow[] = [];
  for (const item of [...input.plans].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const plan = await loadPlanRow(tx, ctx.tenantId, item.id, true);
    if (!plan || !(await hrSees(tx, ctx.hr, plan))) throw new AppError('NOT_FOUND', '发展计划不存在');
    if (plan.revision !== item.revision) throw new AppError('REVISION_CONFLICT', '发展计划已变更，请刷新后重提');
    plans.push(plan);
  }
  if (plans.some((p) => p.status === 'ended' || p.status === 'terminated')) notActive();
  // 先判源字段查看权，再做可区分的校验；记入台账，重放时按当前权限复核（看不到了 403 IDP_CARRY_SOURCE_HIDDEN）
  for (const [object, fields] of ISSUE_SOURCE_FIELDS) {
    if (!viewable(sources[object], fields)) throw hiddenGoal();
    ctx.checks?.push({ kind: 'view', object, fields, carry: true });
  }
  const [goal] = rowsOf<{
    template_id: string;
    task_enabled: boolean | null;
    org_id: string;
    public_down: boolean;
    created_by: string;
  }>(
    await tx.execute(sql`SELECT g.template_id, m.task_enabled, t.org_id, t.public_down, t.created_by
      FROM idp_template_common_goals g
      JOIN idp_template_modules m ON m.tenant_id = g.tenant_id AND m.id = g.module_id
      JOIN idp_templates t ON t.tenant_id = g.tenant_id AND t.id = g.template_id
      WHERE g.tenant_id = ${ctx.tenantId} AND g.id = ${input.commonGoalId}::uuid`),
  );
  const anchor = goal && { orgId: goal.org_id, publicDown: goal.public_down, createdBy: goal.created_by };
  if (!anchor || (await accessOf(tx, ctx, sources.templateScope, anchor)) === 'none') throw hiddenGoal();
  const templates = new Set(plans.map((p) => p.templateId));
  if (templates.size > 1 || !templates.has(goal.template_id)) {
    conflict('IDP_TASK_TEMPLATE_MISMATCH', '所选计划使用了不同的模板，请按模板分开下发');
  }
  if (goal.task_enabled !== true) conflict('IDP_TASK_DISABLED', '该发展目标模块未开启制定任务');
  const created: { planId: string; goalId: string; taskId: string }[] = [];
  for (const plan of plans) {
    const [target] = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM idp_goals WHERE tenant_id = ${ctx.tenantId} AND plan_id = ${plan.id}::uuid
        AND common_goal_id = ${input.commonGoalId}::uuid ORDER BY created_at LIMIT 1`),
    );
    if (!target) conflict('IDP_TASK_GOAL_MISSING', '有计划没有由该通用目标生成的目标，不能统一下发');
    created.push({
      planId: plan.id,
      goalId: target.id,
      taskId: await insertTask(tx, ctx, plan, target.id, input.task),
    });
    await bumpPlan(tx, ctx.tenantId, plan.id, ctx.now);
  }
  return { created };
}
