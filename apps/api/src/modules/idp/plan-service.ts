/**
 * 发展计划的新建 / 修改 / 删除 / 开始（docs/02_业务建模/28 IDP-R13 / R14 / R17；PR 描述 K-20 / K-25 / K-34 / K-40 / K-48）。
 * - 只用已发布模板（K-26）；员工须在操作人 IDP 范围内（范围外 404，K-50）；
 * - 指导人按角色解析为具体人员（K-20），带入通用目标（K-48）：两处都是“从另一个对象带出值”，按操作人对源字段的当前
 *   查看权裁剪（DEC-309，入口清单 E2 / E3）：看不到的通用目标字段留空、看不到通用目标对象不带入；看不到指导人来源字段
 *   视同解析不到（409 IDP_TUTOR_UNRESOLVED，与确实没有时响应一致）；
 * - 阶段按流程的子流程逐段生成；开始后第一段按开启规则（无规则立即开启）；
 * - 删除级联目标 / 任务 / 回顾 / 综述，须有这些对象的删除权（DEC-309④-2，不论是否存在都要求）；运行中的审批实例作废。
 */
import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate, type TutorRole } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { isEmploymentRecordVisible } from '../employment/visibility.js';
import { getModuleViewableFields, resolveModuleScope, scopeAllows } from '../permission/module-access.js';
import { creatorOf, hasCreatorScope } from '../permission/scope-audit.js';
import { auditContents, auditGoalChildren } from './cascade-audit.js';
import { type IdpContext, type ModuleScope, type Projection, requireNestedWrite, rowsOf } from './access.js';
import { employeeInScope, type HrScope, hrSees } from './plan-access.js';
import type { PlanCreate, PlanPatch } from './plan-input.js';
import { loadStages, type PlanRow, requirePlanRow } from './plan-store.js';
import { loadPlanDetail, type PlanDetail, planRecord } from './plan-view.js';
import { registerTemplateReferenceGuard } from './references.js';
import { cancelStageInstance, openStage, type StageActor } from './stage-service.js';
import { audit, conflict, requireRevision, type WriteContext } from './write-support.js';

type Deps = Pick<TenantRouteDeps, 'authorize'>;

// K-25：有计划（含已结束 / 已终止）引用的模板即“被引用”，不能删除、不能增删模块、不能换流程
registerTemplateReferenceGuard(async (tx, tenantId, templateId) => {
  const rows = rowsOf(
    await tx.execute(sql`SELECT 1 FROM idp_plans WHERE tenant_id = ${tenantId} AND template_id = ${templateId}::uuid
      LIMIT 1`),
  );
  return rows.length > 0;
});

/** 新建计划时带出值的源字段查看权（事务外按当前权限解析，DEC-309）。 */
export interface CarrySources {
  readonly commonGoal: Projection;
  readonly employmentRecord: Projection;
  readonly organization: Projection;
  /** 源记录的数据范围（任职记录 / 组织接口 404 的记录不能带出值，第 2 轮 P2-2）。 */
  readonly employmentScope: ModuleScope;
  readonly organizationScope: ModuleScope;
}

async function objectProjection(deps: TenantRouteDeps, ctx: IdpContext, objectCode: string): Promise<Projection> {
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: objectCode, fields: [] }))) return null;
  return getModuleViewableFields(deps, ctx, objectCode);
}

export async function carrySources(
  deps: TenantRouteDeps,
  ctx: IdpContext,
  commonGoal: Projection,
): Promise<CarrySources> {
  const scopeOf = (code: string) => resolveModuleScope(deps, ctx, undefined, code, `${code}.detail`);
  return {
    commonGoal,
    employmentRecord: await objectProjection(deps, ctx, MODULE_OBJECTS.employmentRecord.code),
    organization: await objectProjection(deps, ctx, MODULE_OBJECTS.organization.code),
    employmentScope: await scopeOf(MODULE_OBJECTS.employmentRecord.code),
    organizationScope: await scopeOf(MODULE_OBJECTS.organization.code),
  };
}

const sees = (projection: Projection, field: string) =>
  projection !== null && (projection === undefined || projection.has(field));

export interface PlanWriteContext extends WriteContext {
  readonly hr: HrScope;
}

const actorOf = (ctx: IdpContext): StageActor => ({ ...ctx });

/** 员工须存在且在操作人 IDP 范围内（范围外与不存在同为 404）。 */
async function requireEmployeeInScope(tx: Tx, ctx: PlanWriteContext, employeeId: string): Promise<void> {
  const [row] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_employees WHERE tenant_id = ${ctx.tenantId}
      AND id = ${employeeId}::uuid`),
  );
  if (!row || !(await employeeInScope(tx, ctx.hr, employeeId))) throw new AppError('NOT_FOUND', '员工不存在');
}

const unresolved = () =>
  conflict('IDP_TUTOR_UNRESOLVED', '按指导人角色找不到指导人，请改为指定人员或补全员工的汇报关系');

async function orgRoleOf(tx: Tx, tenantId: string, orgId: string, asOf: string, column: 'head' | 'hrbp') {
  const [row] = rowsOf<{ person_in_charge_id: string | null; hrbp_id: string | null }>(
    await tx.execute(sql`SELECT person_in_charge_id, hrbp_id FROM org_versions WHERE tenant_id = ${tenantId}
      AND org_id = ${orgId}::uuid AND start_date <= ${asOf}::date ORDER BY start_date DESC, version_no DESC LIMIT 1`),
  );
  return (column === 'head' ? row?.person_in_charge_id : row?.hrbp_id) ?? null;
}

/** 组织在操作人组织范围内（与组织详情接口同一判定，含“使用用户”维度的创建人）。 */
async function orgVisible(tx: Tx, ctx: IdpContext, scope: ModuleScope, orgId: string) {
  const creatorId = hasCreatorScope(scope)
    ? await creatorOf(tx, ctx.tenantId, orgId, 'org.create', 'organization')
    : undefined;
  return scopeAllows(scope, { orgId, ...(creatorId ? { creatorId } : {}) });
}

/**
 * 指导人角色 → 具体人员（K-20）：直线经理 / 间接经理取任职记录的直线经理（再上一级），部门负责人 / HRBP 取员工当前部门
 * 的组织版本；源字段看不到、源记录不在操作人数据范围内（间接经理逐跳）都视同解析不到（DEC-309，E3）。第三 / 四 / 五级主管、导师首版解析不到。
 */
async function resolveTutor(
  tx: Tx,
  ctx: PlanWriteContext,
  sources: CarrySources,
  employeeId: string,
  role: TutorRole,
  explicit: string | null | undefined,
): Promise<string> {
  if (role === 'other') return explicit!;
  // 带出源的查看权记入台账，重放时复核（P2-6）
  const record = MODULE_OBJECTS.employmentRecord.code;
  if (role === 'direct_manager' || role === 'indirect_manager') {
    ctx.checks.push({ kind: 'source', objectCode: record, fields: ['directManagerId'] });
  }
  if (role === 'department_head' || role === 'department_hrbp') {
    const field = role === 'department_head' ? 'personInChargeId' : 'hrbpId';
    ctx.checks.push({ kind: 'source', objectCode: record, fields: ['departmentId'] });
    ctx.checks.push({ kind: 'source', objectCode: MODULE_OBJECTS.organization.code, fields: [field] });
  }
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  /** 员工当前任职记录，须在操作人任职记录范围内（与任职记录接口同一可见判定，DEC-177）。 */
  const visibleRecord = async (person: string) => {
    const record = await findCurrentRecord(tx, ctx.tenantId, person, asOf);
    if (!record) return null;
    const departmentId = (record.fields.departmentId as string | null | undefined) ?? null;
    const target = { employeeId: person, departmentId };
    return (await isEmploymentRecordVisible(tx, ctx.tenantId, sources.employmentScope, target)) ? record : null;
  };
  // 间接经理逐跳调用：每一跳的任职记录都单独校验范围
  const managerOf = async (person: string) => {
    if (!sees(sources.employmentRecord, 'directManagerId')) return null;
    const record = await visibleRecord(person);
    return (record?.fields.directManagerId as string | null | undefined) ?? null;
  };
  const departmentRole = async (column: 'head' | 'hrbp') => {
    const field = column === 'head' ? 'personInChargeId' : 'hrbpId';
    if (!sees(sources.employmentRecord, 'departmentId') || !sees(sources.organization, field)) return null;
    const record = await visibleRecord(employeeId);
    const department = (record?.fields.departmentId as string | null | undefined) ?? null;
    if (!department || !(await orgVisible(tx, ctx, sources.organizationScope, department))) return null;
    return orgRoleOf(tx, ctx.tenantId, department, asOf, column);
  };
  let tutor: string | null = null;
  if (role === 'direct_manager') tutor = await managerOf(employeeId);
  if (role === 'indirect_manager') {
    const manager = await managerOf(employeeId);
    tutor = manager ? await managerOf(manager) : null;
  }
  if (role === 'department_head') tutor = await departmentRole('head');
  if (role === 'department_hrbp') tutor = await departmentRole('hrbp');
  if (!tutor || tutor === employeeId) return unresolved();
  return tutor;
}

/** 模板（已发布、操作人看得到）与其流程的子流程。 */
async function requirePublishedTemplate(tx: Tx, ctx: PlanWriteContext, templateId: string) {
  const [template] = rowsOf<{ id: string; status: string; process_id: string }>(
    await tx.execute(sql`SELECT id, status, process_id FROM idp_templates WHERE tenant_id = ${ctx.tenantId}
      AND id = ${templateId}::uuid FOR SHARE`),
  );
  if (!template) throw new AppError('NOT_FOUND', '发展计划模板不存在');
  if (template.status !== 'published') conflict('IDP_TEMPLATE_NOT_PUBLISHED', '只能用已发布的模板新建发展计划');
  const subs = rowsOf<{ id: string; seq: number }>(
    await tx.execute(sql`SELECT id, seq FROM idp_sub_processes WHERE tenant_id = ${ctx.tenantId}
      AND process_id = ${template.process_id}::uuid ORDER BY seq`),
  );
  return { processId: template.process_id, subs };
}

/** 带入模板当时的通用目标（K-48，AC-IDP-04）；看不到的字段留空（排序值取 0）、看不到名称或对象不带入（DEC-309，E2）。 */
async function carryCommonGoals(tx: Tx, ctx: PlanWriteContext, plan: PlanRow, projection: Projection) {
  if (projection === null) return;
  const goals = rowsOf<{
    id: string;
    module_id: string;
    name: string;
    measure: string | null;
    suggestion: string | null;
    display_order: number;
  }>(
    await tx.execute(sql`SELECT id, module_id, name, measure, suggestion, display_order FROM idp_template_common_goals
      WHERE tenant_id = ${ctx.tenantId} AND template_id = ${plan.templateId}::uuid
      ORDER BY display_order, created_at, id`),
  );
  if (!sees(projection, 'name') || !sees(projection, 'moduleId')) return;
  const used = ['name', 'moduleId', 'measure', 'suggestion', 'displayOrder'].filter((f) => sees(projection, f));
  if (goals.length) ctx.checks.push({ kind: 'view', object: 'commonGoal', fields: used, carry: true });
  for (const goal of goals) {
    const values = {
      moduleId: goal.module_id,
      name: goal.name,
      measure: sees(projection, 'measure') ? goal.measure : null,
      suggestion: sees(projection, 'suggestion') ? goal.suggestion : null,
      displayOrder: sees(projection, 'displayOrder') ? Number(goal.display_order) : 0,
    };
    const [row] = rowsOf<{ id: string }>(
      await tx.execute(sql`INSERT INTO idp_goals (tenant_id, plan_id, module_id, name, measure, suggestion,
        source_type, common_goal_id, display_order, created_by, created_at)
        VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${values.moduleId}::uuid, ${values.name}, ${values.measure},
          ${values.suggestion}, 'common', ${goal.id}::uuid, ${values.displayOrder}, ${ctx.userId}::uuid,
          ${ctx.now.toISOString()}) RETURNING id`),
    );
    await audit(tx, ctx, 'goal', 'create', row!.id, {
      before: null,
      after: { planId: plan.id, sourceType: 'common', commonGoalId: goal.id, ...values },
      employeeId: plan.employeeId,
    });
  }
}

async function detailOf(tx: Tx, ctx: IdpContext, planId: string): Promise<PlanDetail> {
  const row = await requirePlanRow(tx, ctx.tenantId, planId);
  return loadPlanDetail(tx, row, tenantLocalDate(ctx.now, ctx.timezone));
}

export async function createPlan(tx: Tx, ctx: PlanWriteContext, sources: CarrySources, input: PlanCreate) {
  await requireEmployeeInScope(tx, ctx, input.employeeId);
  const template = await requirePublishedTemplate(tx, ctx, input.templateId);
  const tutor = await resolveTutor(tx, ctx, sources, input.employeeId, input.tutorRole, input.tutorEmployeeId);
  const [inserted] = rowsOf<{ id: string }>(
    await tx.execute(sql`INSERT INTO idp_plans (tenant_id, name, employee_id, template_id, process_id, start_date,
      end_date, tutor_role, tutor_employee_id, status, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${input.name}, ${input.employeeId}::uuid, ${input.templateId}::uuid,
        ${template.processId}::uuid, ${input.startDate}::date, ${input.endDate}::date, ${input.tutorRole},
        ${tutor}::uuid, 'not_started', ${ctx.userId}::uuid, ${ctx.now.toISOString()}, ${ctx.now.toISOString()})
      RETURNING id`),
  );
  const plan = await requirePlanRow(tx, ctx.tenantId, inserted!.id);
  for (const sub of template.subs) {
    await tx.execute(sql`INSERT INTO idp_plan_stages (tenant_id, plan_id, sub_process_id, seq)
      VALUES (${ctx.tenantId}, ${plan.id}::uuid, ${sub.id}::uuid, ${Number(sub.seq)})`);
  }
  await audit(tx, ctx, 'plan', 'create', plan.id, {
    before: null,
    after: planRecord(plan),
    employeeId: plan.employeeId,
  });
  await carryCommonGoals(tx, ctx, plan, sources.commonGoal);
  return detailOf(tx, ctx, plan.id);
}

/** 写入口共用：行锁 → 存在 → 范围（范围外 404）→ revision。 */
export async function lockPlanForHr(tx: Tx, ctx: PlanWriteContext, id: string): Promise<PlanRow> {
  const row = await requirePlanRow(tx, ctx.tenantId, id, true);
  if (!(await hrSees(tx, ctx.hr, row))) throw new AppError('NOT_FOUND', '发展计划不存在');
  requireRevision(ctx, row.revision, '发展计划');
  return row;
}

const isActive = (row: PlanRow) => row.status === 'not_started' || row.status === 'running';

export async function updatePlan(tx: Tx, ctx: PlanWriteContext, sources: CarrySources, id: string, patch: PlanPatch) {
  const row = await lockPlanForHr(tx, ctx, id);
  if (!isActive(row)) conflict('IDP_PLAN_NOT_ACTIVE', '已结束或已终止的计划不能修改');
  if ((patch.startDate !== undefined || patch.endDate !== undefined) && row.status !== 'not_started') {
    conflict('IDP_PLAN_STARTED', '计划已开始，不能修改起止时间');
  }
  const startDate = patch.startDate ?? row.startDate;
  const endDate = patch.endDate ?? row.endDate;
  if (endDate < startDate) throw new AppError('VALIDATION_FAILED', '结束时间不能早于开始时间');
  const role = patch.tutorRole ?? (row.tutorRole as TutorRole);
  const retutor = patch.tutorRole !== undefined || patch.tutorEmployeeId !== undefined;
  if (retutor && role === 'other' && !(patch.tutorEmployeeId ?? (patch.tutorRole ? null : row.tutorEmployeeId))) {
    throw new AppError('VALIDATION_FAILED', '指导人角色为“其他人”时须指定指导人');
  }
  const tutor = retutor
    ? await resolveTutor(tx, ctx, sources, row.employeeId, role, patch.tutorEmployeeId ?? row.tutorEmployeeId)
    : row.tutorEmployeeId;
  await tx.execute(sql`UPDATE idp_plans SET name = ${patch.name ?? row.name}, start_date = ${startDate}::date,
    end_date = ${endDate}::date, tutor_role = ${role}, tutor_employee_id = ${tutor}::uuid,
    revision = revision + 1, updated_at = ${ctx.now.toISOString()}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  const after = await requirePlanRow(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'plan', 'update', id, {
    before: planRecord(row),
    after: planRecord(after),
    employeeId: row.employeeId,
  });
  return detailOf(tx, ctx, id);
}

/** 开始（K-40）：未开始 → 进行中；第一段“自动、无规则”立即开启，手动等 HR，有规则交调度。 */
export async function startPlan(tx: Tx, ctx: PlanWriteContext, id: string) {
  const row = await lockPlanForHr(tx, ctx, id);
  if (row.status !== 'not_started') conflict('IDP_PLAN_NOT_STARTABLE', '只有未开始的计划可以开始');
  await tx.execute(sql`UPDATE idp_plans SET status = 'running', revision = revision + 1,
    updated_at = ${ctx.now.toISOString()} WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'plan', 'update', id, {
    before: { status: row.status },
    after: { status: 'running' },
    employeeId: row.employeeId,
  });
  const running = await requirePlanRow(tx, ctx.tenantId, id);
  const [first] = await loadStages(tx, ctx.tenantId, [id]);
  if (first && first.startMode === 'auto' && first.startTimeType === null) {
    await openStage(tx, actorOf(ctx), running, first);
  }
  return detailOf(tx, ctx, id);
}

/** 删除（IDP-R17 不可恢复，K-34）：级联子对象须有删除权（DEC-309④-2），运行中的审批实例作废，留快照。 */
export async function deletePlan(tx: Tx, deps: Deps, ctx: PlanWriteContext, id: string) {
  const row = await lockPlanForHr(tx, ctx, id);
  for (const child of ['goal', 'task', 'goalReview', 'analysis', 'review'] as const) {
    await requireNestedWrite(tx, deps, ctx, child, 'delete');
  }
  const before = await loadPlanDetail(tx, row, tenantLocalDate(ctx.now, ctx.timezone));
  for (const stage of await loadStages(tx, ctx.tenantId, [id])) {
    if (stage.status === 'running') await cancelStageInstance(tx, actorOf(ctx), row, stage);
  }
  // 子对象各写删除日志，目标快照保留其任务与目标回顾（K-34 / DEC-216，P2-10）
  await auditGoalChildren(tx, ctx, row);
  await auditContents(tx, ctx, row);
  for (const goal of before.goals) {
    await audit(tx, ctx, 'goal', 'delete', goal.id, { before: goal, after: null, employeeId: row.employeeId });
  }
  await tx.execute(sql`DELETE FROM idp_plans WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'plan', 'delete', id, { before: planRecord(row), after: null, employeeId: row.employeeId });
  return before;
}
