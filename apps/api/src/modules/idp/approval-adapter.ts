/**
 * 审批中心的发展计划适配器（R3-T07 PR-B；K-08 / K-37～K-39 / K-47）：业务单 = 计划的一个阶段（子流程实例）。
 * - 快照：主体 = 计划员工，指导人供 idp_tutor 解析；不带表单字段与变化字段（计划内容在 IDP 内按节点按钮维护，DEC-296④），
 *   标题不含个人数据（DEC-057）；
 * - 实例完成 = 阶段结束（onStageApproved）；驳回（到发起人）与撤回后实例等所有者重提，阶段保持进行中；重提不带
 *   修正内容（计划内容按节点按钮维护）；不同意结束流程 → 阶段开启失败，HR 查明后手动重开（DEC-318 K-39，不再一刀切
 *   禁用）。审批中心的“编辑”对 IDP 不可用（审批类型不支持审批中编辑，内容由节点按钮决定）；
 * - 同意前：节点配置了“新增目标”的发展目标模块开启无目标校验时，该模块须有目标（IDP-R10，AC-IDP-05）。
 * 取锁顺序：计划 → 审批实例（审批命令先经 lock 锁计划行，再锁实例）。
 */
import { sql, type Tx } from '@italent/db';
import { APPROVAL_TYPES, type ApprovalTypeCode, IDP_OBJECTS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import type { BusinessAdapter, BusinessSnapshot } from '../approval/adapters.js';
import type { ApprovalContext } from '../approval/context.js';
import { rowsOf } from './access.js';
import { loadStage, requirePlanRow } from './plan-store.js';
import { onStageApproved, onStageDisapproved } from './stage-service.js';

async function stageOf(tx: Tx, tenantId: string, stageId: string) {
  const stage = await loadStage(tx, tenantId, stageId);
  if (!stage) throw new AppError('NOT_FOUND', '发展计划阶段不存在');
  return stage;
}

/** 无目标校验（IDP-R10）：本节点有“新增目标”按钮、且开启了无目标校验的发展目标模块，计划在该模块下须至少有一个目标。 */
async function requireGoals(tx: Tx, ctx: ApprovalContext, stageId: string, nodeKey: string): Promise<void> {
  const stage = await stageOf(tx, ctx.tenantId, stageId);
  const [missing] = rowsOf<{ name: string }>(
    await tx.execute(sql`SELECT m.name FROM idp_plans p
      JOIN idp_template_modules m ON m.tenant_id = p.tenant_id AND m.template_id = p.template_id
        AND m.module_type = 'goal' AND m.check_none_goal
      JOIN idp_template_node_settings n ON n.tenant_id = m.tenant_id AND n.module_id = m.id
        AND n.sub_process_id = ${stage.subProcessId}::uuid AND n.node_key = ${nodeKey} AND n.enabled
        AND 'RowAddIdpGoal' = ANY(n.buttons)
      WHERE p.tenant_id = ${ctx.tenantId} AND p.id = ${stage.planId}::uuid
        AND NOT EXISTS (SELECT 1 FROM idp_goals g WHERE g.tenant_id = p.tenant_id AND g.plan_id = p.id
          AND g.module_id = m.id)
      ORDER BY m.display_order LIMIT 1`),
  );
  if (missing) {
    throw new AppError('CONFLICT', `「${missing.name}」还没有发展目标，不能提交`, { reason: 'IDP_GOAL_REQUIRED' });
  }
}

/** 计划已删除后，审批记录仍可查（实例已作废）：审批类型与主体取实例上的冻结值。 */
async function deletedInstance(tx: Tx, tenantId: string, stageId: string) {
  const [row] = rowsOf<{ approval_type: string; subject_employee_id: string | null }>(
    await tx.execute(sql`SELECT approval_type, subject_employee_id FROM approval_instances
      WHERE tenant_id = ${tenantId} AND business_type = 'idp' AND business_id = ${stageId}::uuid
      ORDER BY created_at DESC LIMIT 1`),
  );
  if (!row) throw new AppError('NOT_FOUND', '发展计划阶段不存在');
  return row;
}

const deletedType = async (tx: Tx, tenantId: string, stageId: string) =>
  (await deletedInstance(tx, tenantId, stageId)).approval_type;
const deletedSubject = async (tx: Tx, tenantId: string, stageId: string) =>
  (await deletedInstance(tx, tenantId, stageId)).subject_employee_id;

export const idpAdapter: BusinessAdapter = {
  async lock(tx, ctx, stageId) {
    const stage = await loadStage(tx, ctx.tenantId, stageId);
    // 计划已删除（IDP-R17）：审批实例已作废、只剩记录可查，没有业务行可锁
    if (stage) await requirePlanRow(tx, ctx.tenantId, stage.planId, true);
  },
  async snapshot(tx, ctx, stageId): Promise<BusinessSnapshot> {
    const stage = await loadStage(tx, ctx.tenantId, stageId);
    const plan = stage ? await requirePlanRow(tx, ctx.tenantId, stage.planId) : null;
    const approvalType = (stage?.approvalType ?? (await deletedType(tx, ctx.tenantId, stageId))) as ApprovalTypeCode;
    return {
      approvalType,
      businessType: 'idp',
      businessId: stageId,
      fieldObjectCode: IDP_OBJECTS.plan.code,
      profileFields: [],
      subjectEmployeeId: plan?.employeeId ?? (await deletedSubject(tx, ctx.tenantId, stageId)),
      tutorEmployeeId: plan?.tutorEmployeeId ?? null,
      title: `发展计划${APPROVAL_TYPES[approvalType].name}`,
      values: {},
      originals: null,
      changedFields: [],
      conditionValues: {},
      latestDepartmentId: null,
      recordDepartmentId: null,
      // 计划内容不随审批冻结（按节点按钮实时维护），载荷版本固定为阶段本身
      version: stageId,
      processCode: null,
    };
  },
  async approved(tx, ctx, stageId) {
    const stage = await stageOf(tx, ctx.tenantId, stageId);
    const plan = await requirePlanRow(tx, ctx.tenantId, stage.planId);
    // 实际操作人：审批人本人；调度发起后当场走完的实例为系统
    const userId = ctx.actorUserId === null ? SYSTEM_USER_ID : (ctx.actorUserId ?? ctx.userId);
    await onStageApproved(tx, { ...ctx, userId }, plan, stage);
  },
  // 驳回 / 撤回：实例退回所有者，阶段保持进行中（没有在办任务，执行人入口随之关闭）
  async rejected() {},
  async withdrawn() {},
  async disapproved(tx, ctx, stageId) {
    const stage = await stageOf(tx, ctx.tenantId, stageId);
    const plan = await requirePlanRow(tx, ctx.tenantId, stage.planId);
    const userId = ctx.actorUserId === null ? SYSTEM_USER_ID : (ctx.actorUserId ?? ctx.userId);
    await onStageDisapproved(tx, { ...ctx, userId }, plan, stage);
  },
  async resubmit(_tx, _ctx, _stageId, corrections) {
    if (Object.keys(corrections).length) {
      throw new AppError('VALIDATION_FAILED', '发展计划重提不带修正内容，请按节点按钮维护计划');
    }
  },
  edit() {
    throw new AppError('CONFLICT', '发展计划在审批中的修改按节点按钮进行', { reason: 'APPROVAL_EDIT_UNSUPPORTED' });
  },
  beforeApprove: requireGoals,
};
