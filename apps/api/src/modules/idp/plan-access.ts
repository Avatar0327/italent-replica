/**
 * 发展计划的查看人与执行人判定（PR 描述矩阵第二节；DEC-296④ / DEC-307；K-30～K-32 按现状）：
 * - HR：持 IDP.Idp 查看权，计划员工当前任职在其 IDP 范围内（K-50）；
 * - 参与人：计划员工本人、指导人（计划非“未开始”，K-32），或当前阶段的在办待办人（步骤审批人）；
 *   直线经理（非指导人）、带教人（非指导人）不是参与人（K-30 / K-31 按现状不可见）；
 * - 执行人：当前阶段的在办待办人，且模板模块在该（子流程 × 节点）上启用并配置了对应按钮（fail-closed）。
 * 既不是 HR 也不是参与人一律 404（不泄露计划是否存在）；看得到但不是执行人 403 IDP_NODE_BUTTON_DENIED。
 * 打开详情时另按模板模块判定（F-164，DEC-518 / DEC-523）：除基本信息外没有模块 → 403 IDP_PLAN_NO_VISIBLE_MODULE。
 */
import { sql, type Tx } from '@italent/db';
import type { NodeButton } from '@italent/domain';
import { AppError } from '../../errors.js';
import { personOfUser } from '../approval/resolver.js';
import { scopeAllowsInTransaction } from '../permission/module-access.js';
import { type ModuleScope, rowsOf } from './access.js';
import { pendingNodeOf, type PlanRow, type StageRow } from './plan-store.js';

export interface Participation {
  /** 本人 / 指导人 / 在办待办人之一。 */
  readonly participant: boolean;
  /** 在办任务所在的运行中阶段与节点（不是待办人为 null）。 */
  readonly stage: StageRow | null;
  readonly nodeKey: string | null;
}

export async function participation(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  plan: PlanRow,
  stages: readonly StageRow[],
): Promise<Participation> {
  const person = await personOfUser(tx, ctx.tenantId, ctx.userId);
  const started = plan.status !== 'not_started';
  const related = started && person !== null && (person === plan.employeeId || person === plan.tutorEmployeeId);
  const running =
    plan.status === 'running' ? stages.find((s) => s.status === 'running' && s.approvalInstanceId) : undefined;
  const nodeKey = running ? await pendingNodeOf(tx, ctx.tenantId, running.approvalInstanceId!, ctx.userId) : null;
  return { participant: related || nodeKey !== null, stage: nodeKey ? running! : null, nodeKey };
}

export type PlanViewer = { readonly kind: 'hr' } | { readonly kind: 'participant'; readonly at: Participation };

/** HR 范围（路由在事务外解析；没有 IDP.Idp 查看权为 null）。 */
export type HrScope = ModuleScope | null;

/** 员工当前任职在 HR 的 IDP 范围内（K-50）。 */
export async function employeeInScope(tx: Tx, hr: HrScope, employeeId: string): Promise<boolean> {
  return hr !== null && (await scopeAllowsInTransaction(tx, hr, { personId: employeeId }));
}

export const hrSees = (tx: Tx, hr: HrScope, plan: Pick<PlanRow, 'employeeId'>) =>
  employeeInScope(tx, hr, plan.employeeId);

/** 查看人：HR 优先（范围内），否则参与人；都不是 → 404。 */
export async function requireViewer(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  hr: HrScope,
  plan: PlanRow,
  stages: readonly StageRow[],
): Promise<PlanViewer> {
  if (await hrSees(tx, hr, plan)) return { kind: 'hr' };
  const at = await participation(tx, ctx, plan, stages);
  if (!at.participant) throw new AppError('NOT_FOUND', '发展计划不存在');
  return { kind: 'participant', at };
}

/**
 * 打开详情（F-164，DEC-518 / DEC-523）：模板除基本信息外没有模块时，任何查看人都无权查看（原站“无权限查看当前发展计划”）。
 * 原站按“步骤 × 角色可见模块”判定，复刻只看模板有没有基本信息以外的模块（L2 取舍 A10）。须在 requireViewer 之后调用，
 * 看不到的仍 404；写入后的计划回显不经此判定（HR 新建、开始这类计划照常返回）。
 */
export async function requireVisibleModule(tx: Tx, tenantId: string, plan: Pick<PlanRow, 'templateId'>) {
  const [row] = rowsOf<{ found: number }>(
    await tx.execute(sql`SELECT 1 AS found FROM idp_template_modules
      WHERE tenant_id = ${tenantId} AND template_id = ${plan.templateId}::uuid AND module_type <> 'basic' LIMIT 1`),
  );
  if (!row) throw new AppError('FORBIDDEN', '无权限查看当前发展计划', { reason: 'IDP_PLAN_NO_VISIBLE_MODULE' });
}

/** 某模块在（子流程 × 节点）上启用的按钮（未配置 = 无按钮）。 */
export async function nodeButtons(
  tx: Tx,
  tenantId: string,
  stage: StageRow,
  nodeKey: string,
): Promise<Map<string, readonly string[]>> {
  const rows = rowsOf<{ module_id: string; buttons: string[] }>(
    await tx.execute(sql`SELECT module_id, buttons FROM idp_template_node_settings
      WHERE tenant_id = ${tenantId} AND sub_process_id = ${stage.subProcessId}::uuid AND node_key = ${nodeKey}
        AND enabled`),
  );
  return new Map(rows.map((r) => [r.module_id, r.buttons]));
}

const denied = () => new AppError('FORBIDDEN', '当前节点没有该操作的权限', { reason: 'IDP_NODE_BUTTON_DENIED' });

export interface Executor {
  readonly stage: StageRow;
  readonly nodeKey: string;
}

/**
 * 执行人（DEC-296④）：看得到计划（HR 或参与人，否则 404），且是当前阶段的在办待办人、模块在该节点配置了按钮
 * （否则 403）。HR 不经节点按钮不能改目标 / 任务 / 回顾（K-49）。
 */
export async function requireExecutor(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  hr: HrScope,
  plan: PlanRow,
  stages: readonly StageRow[],
  moduleId: string,
  button: NodeButton,
): Promise<Executor> {
  const at = await participation(tx, ctx, plan, stages);
  if (!at.participant && !(await hrSees(tx, hr, plan))) throw new AppError('NOT_FOUND', '发展计划不存在');
  if (!at.stage || !at.nodeKey) throw denied();
  const buttons = (await nodeButtons(tx, ctx.tenantId, at.stage, at.nodeKey)).get(moduleId) ?? [];
  if (!buttons.includes(button)) throw denied();
  return { stage: at.stage, nodeKey: at.nodeKey };
}
