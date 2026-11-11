/**
 * 审批中心入口的 IDP 办理时内容（F-476 P8 返工 P2-3）：已办读冻结份时，GET /approval/instances/:id 与计划详情
 * 读到同一份内容（共用 stage-content.presentFrozen）；扩展缺失 / 形状不对 → 503 APPROVAL_HANDLING_CONTENT_MISSING，
 * 不退回现值（DEC-807）。调用方已按审批中心的查看规则放行本实例，这里不另放宽：呈现用只读的参与人字段集。
 * 完整办理份的呈现不依赖计划现存（第 2 轮返工）：计划被删除（级联删阶段）后，进度类字段置空，内容只取自办理份。
 */
import { withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { loadPlanRow } from './plan-store.js';
import { loadPlanDetail, planProjections } from './plan-view.js';
import { parseIdpStageContent, presentFrozen } from './stage-content.js';

export async function idpFrozenContent(deps: TenantRouteDeps, tenant: TenantContext, ext: unknown, stageId: string) {
  const content = parseIdpStageContent(ext, stageId);
  const now = deps.clock();
  const projections = await planProjections(deps, { ...tenant, expectedRevision: 0, now, commandId: '' });
  return withTenant(deps.db, tenant.tenantId, async (tx) => {
    const plan = await loadPlanRow(tx, tenant.tenantId, content.plan.id);
    const live = plan ? await loadPlanDetail(tx, plan, tenantLocalDate(now, tenant.timezone)) : null;
    return presentFrozen(tx, tenant.tenantId, live, content, projections);
  });
}
