/**
 * 审批中心入口的 IDP 办理时内容（F-476 P8 返工 P2-3）：已办读冻结份时，GET /approval/instances/:id 与计划详情
 * 读到同一份内容（共用 stage-content.presentFrozen）；扩展缺失 / 形状不对 → 503 APPROVAL_HANDLING_CONTENT_MISSING，
 * 不退回现值（DEC-807）。调用方已按审批中心的查看规则放行本实例，这里不另放宽：呈现用只读的参与人字段集。
 */
import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { loadStage, requirePlanRow } from './plan-store.js';
import { loadPlanDetail, planProjections } from './plan-view.js';
import { presentFrozen } from './stage-content.js';

export async function idpFrozenContent(deps: TenantRouteDeps, tenant: TenantContext, ext: unknown, stageId: string) {
  const now = deps.clock();
  const ctx = { ...tenant, expectedRevision: 0, now, commandId: '' };
  const projections = await planProjections(deps, ctx);
  return withTenant(deps.db, tenant.tenantId, async (tx) => {
    const stage = await loadStage(tx, tenant.tenantId, stageId);
    const plan = await requirePlanRow(tx, tenant.tenantId, stage?.planId ?? stageId);
    const detail = await loadPlanDetail(tx, plan, tenantLocalDate(now, tenant.timezone));
    return presentFrozen(tx, tenant.tenantId, detail, ext, stageId, projections);
  });
}
