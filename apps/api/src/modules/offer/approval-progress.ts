/**
 * Offer 审批进度（BE-14a3；A19 视图“当前审批人 / 当前审批节点”）：取 Offer 自己的或所在批量单的在途审批实例，
 * 当前审批人 = 本轮在办待办的处理人姓名（同 employee-self-service 的 currentHandlers），节点名取实例冻结版本。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from '../approval/context.js';

export interface ApprovalProgress {
  readonly currentApprovers: readonly string[];
  readonly currentApprovalNode: string | null;
}

const NONE: ApprovalProgress = { currentApprovers: [], currentApprovalNode: null };

export async function approvalProgress(
  tx: Tx,
  tenantId: string,
  offerIds: readonly string[],
): Promise<Map<string, ApprovalProgress>> {
  const result = new Map<string, ApprovalProgress>();
  if (!offerIds.length) return result;
  const rows = rowsOf<{ offer_id: string; node: string | null; approvers: string[] }>(
    await tx.execute(sql`WITH targets AS (
        SELECT o.id AS offer_id, o.id AS business_id, 'offer' AS business_type FROM offers o
          WHERE o.tenant_id = ${tenantId} AND o.id = ANY(${`{${offerIds.join(',')}}`}::uuid[])
        UNION ALL
        SELECT b.offer_id, b.batch_id, 'offer_batch' FROM offer_batch_approval_items b
          WHERE b.tenant_id = ${tenantId} AND b.offer_id = ANY(${`{${offerIds.join(',')}}`}::uuid[]))
      SELECT t.offer_id::text, n.name AS node, ARRAY(
          SELECT DISTINCT a.display_name FROM approval_tasks k
          CROSS JOIN LATERAL tenant_member_accounts(ARRAY[k.assignee_user_id]::uuid[]) a
          WHERE k.tenant_id = i.tenant_id AND k.instance_id = i.id AND k.status = 'pending'
          ORDER BY a.display_name) AS approvers
      FROM targets t
      JOIN approval_instances i ON i.tenant_id = ${tenantId} AND i.business_type = t.business_type
        AND i.business_id = t.business_id AND i.status = 'running'
      LEFT JOIN approval_process_nodes n ON n.tenant_id = i.tenant_id AND n.version_id = i.version_id
        AND n.node_key = i.current_node_key`),
  );
  for (const row of rows) result.set(row.offer_id, { currentApprovers: row.approvers, currentApprovalNode: row.node });
  return result;
}

/** 给接口形状补审批进度（没有在途实例时为空）。 */
export async function withApprovalProgress<T extends Readonly<Record<string, unknown>>>(
  tx: Tx,
  tenantId: string,
  dtos: readonly T[],
): Promise<(T & ApprovalProgress)[]> {
  const progress = await approvalProgress(
    tx,
    tenantId,
    dtos.map((dto) => String(dto.id)),
  );
  return dtos.map((dto) => ({ ...dto, ...(progress.get(String(dto.id)) ?? NONE) }));
}
