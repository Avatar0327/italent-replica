/**
 * 转交目标例外：计划当前登记的指导人 / 带教人（DEC-354 / F-068）的共享判定，IDP 入口的转交（intervention-service.ts）
 * 与审批中心通用的 admin-transfer / admin-intervene（approval/access.ts，DEC-358① / F-067）都调用这里，不各写一套：
 * - 指导人 = 计划行 `tutor_employee_id` 的当前值（不用发起时冻结值）；带教人 = 带教期间与计划期间有交集、被带教人是
 *   计划员工的带教记录（IDP-R7 同一交集口径）；都现查，改掉指导人 / 删掉带教记录后立即失效；
 * - 操作人看不到来源字段视同不是，避免经 200 / 404 差异外泄（DEC-309 / 入口清单 E3）；
 * - 仅凭例外放行的目标，其后任何失败都折成与普通范围外拒绝相同的响应（`foldMentorFailure`），失败的转交不能用来
 *   探测不可见的指导 / 带教关系。两个入口各自提供“普通范围外拒绝”的响应工厂（响应体不同），归一化逻辑共用。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type IdpContext, type Projection, projectionOf, rowsOf, viewable } from './access.js';
import { loadPlanRow, loadStage, type PlanRow } from './plan-store.js';

/** 转交目标例外的来源字段投影（事务外按操作人当前权限解析，看不到视同不是，DEC-309 / E3）。 */
export interface TransferSources {
  readonly plan: Projection;
  readonly tutorship: Projection;
}

const TUTORSHIP_FIELDS = ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate'] as const;

export async function mentorSourcesOf(deps: TenantRouteDeps, ctx: IdpContext): Promise<TransferSources> {
  return { plan: await projectionOf(deps, ctx, 'plan'), tutorship: await projectionOf(deps, ctx, 'tutorship') };
}

/**
 * 目标是该计划“当前登记”的指导人（计划行的 tutor_employee_id，取当前值而非开始时冻结值），或带教期间与计划期间有交集
 * 的带教人（带教人 = 目标、被带教人 = 计划员工，IDP-R7 同一交集口径）；改掉指导人、删掉带教记录后立即失效（DEC-354）。
 */
export async function isPlanMentor(
  tx: Tx,
  plan: PlanRow,
  employeeId: string,
  sources: TransferSources,
): Promise<boolean> {
  if (viewable(sources.plan, ['tutorEmployeeId']) && plan.tutorEmployeeId === employeeId) return true;
  if (!viewable(sources.tutorship, TUTORSHIP_FIELDS)) return false;
  const [hit] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM idp_tutorships WHERE tenant_id = ${plan.tenantId}
      AND tutor_employee_id = ${employeeId}::uuid AND tutee_employee_id = ${plan.employeeId}::uuid
      AND start_date <= ${plan.endDate}::date AND (end_date IS NULL OR end_date >= ${plan.startDate}::date) LIMIT 1`),
  );
  return hit !== undefined;
}

/** 审批阶段（审批实例的业务单 = 计划的一个阶段）所属计划的指导人 / 带教人判定，供审批中心通用入口使用。 */
export async function isStageMentor(
  tx: Tx,
  tenantId: string,
  stageId: string,
  employeeId: string,
  sources: TransferSources,
): Promise<boolean> {
  const stage = await loadStage(tx, tenantId, stageId);
  const plan = stage ? await loadPlanRow(tx, tenantId, stage.planId) : undefined;
  return plan !== undefined && (await isPlanMentor(tx, plan, employeeId, sources));
}

/** 目标是怎样放行的：在操作人范围内，或仅凭指导人 / 带教人例外（后者其后的失败须折成普通拒绝）。 */
export type TargetAdmission = 'scope' | 'mentor';

/**
 * 仅凭例外（`mentor`）放行的目标：`run` 里任何业务失败（AppError：版本冲突、流程已结束、待办无效、回避、重复办理人……）
 * 都改成 `hidden()`，即与普通范围外目标相同的响应；非业务错误（数据库故障等）照常抛出。`scope` 放行的目标不改动。
 */
export async function foldMentorFailure<T>(
  admission: TargetAdmission,
  hidden: () => AppError,
  run: () => Promise<T>,
): Promise<T> {
  if (admission !== 'mentor') return run();
  try {
    return await run();
  } catch (error) {
    throw error instanceof AppError ? hidden() : error;
  }
}
