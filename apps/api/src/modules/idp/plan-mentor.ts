/**
 * 转交目标例外：计划当前登记的指导人 / 带教人（DEC-354；审批中心通用转交同样适用，DEC-358①）。
 * 口径与 IDP 入口的转交一致（F-068）：指导人 = 计划行 `tutor_employee_id` 的当前值（不用发起时冻结值）；
 * 带教人 = 带教期间与计划期间有交集、被带教人是计划员工的带教记录（IDP-R7 同一交集口径），都现查；
 * 操作人看不到来源字段视同不是，避免经 200 / 404 差异外泄（DEC-309 / 入口清单 E3）。
 */
import { sql, type Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import { type IdpContext, type Projection, projectionOf, rowsOf, viewable } from './access.js';
import { loadStage, loadPlanRow } from './plan-store.js';

/** 操作人对两个来源对象的字段投影（事务外按当前权限解析）。 */
export interface MentorSources {
  readonly plan: Projection;
  readonly tutorship: Projection;
}

const TUTORSHIP_FIELDS = ['tutorEmployeeId', 'tuteeEmployeeId', 'startDate', 'endDate'] as const;

export async function mentorSourcesOf(deps: TenantRouteDeps, ctx: IdpContext): Promise<MentorSources> {
  return { plan: await projectionOf(deps, ctx, 'plan'), tutorship: await projectionOf(deps, ctx, 'tutorship') };
}

/** 目标是该计划（按阶段定位）当前登记的指导人，或带教期间与计划期间有交集的带教人。 */
export async function isStageMentor(
  tx: Tx,
  tenantId: string,
  stageId: string,
  employeeId: string,
  sources: MentorSources,
): Promise<boolean> {
  const stage = await loadStage(tx, tenantId, stageId);
  const plan = stage ? await loadPlanRow(tx, tenantId, stage.planId) : undefined;
  if (!plan) return false;
  if (viewable(sources.plan, ['tutorEmployeeId']) && plan.tutorEmployeeId === employeeId) return true;
  if (!viewable(sources.tutorship, TUTORSHIP_FIELDS)) return false;
  const [hit] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM idp_tutorships WHERE tenant_id = ${tenantId}
      AND tutor_employee_id = ${employeeId}::uuid AND tutee_employee_id = ${plan.employeeId}::uuid
      AND start_date <= ${plan.endDate}::date AND (end_date IS NULL OR end_date >= ${plan.startDate}::date) LIMIT 1`),
  );
  return hit !== undefined;
}
