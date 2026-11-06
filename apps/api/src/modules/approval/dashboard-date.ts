/** F-417③：已完成审批的看板日期投影，跟随同一业务的当前日期；业务版本与审批结果不变。 */
import { sql, type Tx } from '@italent/db';
import { auditApproval, emitOutbox, schedulerAwareContext, type ApprovalContext } from './context.js';
import { latestInstanceOf, loadInstance } from './store.js';

/** 规格 35 B51：离职 / 退休取最后工作日，其余任职业务取生效日期；发起快照与后续改期共用。 */
export const employmentDashboardDate = (
  kind: string,
  lastWorkDate: string | null | undefined,
  effectiveDate: string,
) => (['leave', 'retirement'].includes(kind) ? (lastWorkDate ?? effectiveDate) : effectiveDate);

/** 调用方已持有业务锁；按业务→实例锁序更新。只刷新最近一次审批，不能把后续重提的日期写回更早的审批历史。 */
export async function refreshApprovedDashboardDate(
  tx: Tx,
  ctx: ApprovalContext,
  type: 'employment' | 'offer',
  businessId: string,
  date: string | null,
): Promise<void> {
  const latest = await latestInstanceOf(tx, ctx.tenantId, type, businessId);
  if (!latest || latest.status !== 'approved' || latest.dashboardDate === date) return;
  const before = await loadInstance(tx, ctx.tenantId, latest.id, true);
  if (before.status !== 'approved' || before.dashboardDate === date) return;
  const revision = Number(before.revision) + 1;
  await tx.execute(sql`UPDATE approval_instances SET business_date=${date}::date,
    revision=${revision}, updated_at=${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND id=${before.id}::uuid`);
  const context = schedulerAwareContext(ctx);
  const action = 'approval.instance.dashboard_date_refreshed';
  await auditApproval(tx, context, {
    action,
    objectType: 'approval-instance',
    objectId: before.id,
    before: { businessDate: before.dashboardDate },
    after: { businessDate: date },
  });
  await emitOutbox(tx, context, { objectType: 'approval-instance', objectId: before.id, eventType: action, revision });
}
