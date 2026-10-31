/** F-140b2：锁计划与后继复制共用；锁内再读，按整条前单链排除已成功职责。 */
import { sql, type Tx } from '@italent/db';
import { latestLinkage } from '../transfer/linkage/store.js';
import { rowsOf } from './record-store.js';

export async function remainingExitDuties(tx: Tx, tenantId: string, businessId: string) {
  const linkage = await latestLinkage(tx, tenantId, businessId);
  if (!linkage?.options.dutyTransfer) return null;
  const succeeded = rowsOf<{
    subordinateId: string | null;
    relation: string | null;
    orgId: string | null;
    role: string | null;
  }>(
    await tx.execute(sql`WITH RECURSIVE chain AS (
      SELECT business_id,supersedes_business_id FROM exit_requests WHERE tenant_id=${tenantId}
        AND business_id=${businessId}::uuid
      UNION ALL SELECT r.business_id,r.supersedes_business_id FROM exit_requests r JOIN chain c
        ON r.business_id=c.supersedes_business_id WHERE r.tenant_id=${tenantId}
    ) SELECT i.subordinate_id::text AS "subordinateId",i.relation,i.org_id::text AS "orgId",i.org_role AS role
      FROM transfer_linkage_items i JOIN chain c ON c.business_id=i.business_id
      WHERE i.tenant_id=${tenantId} AND i.status='succeeded'`),
  );
  const duties = linkage.options.dutyTransfer;
  const dutyTransfer = {
    subordinates: duties.subordinates.filter(
      (d) => !succeeded.some((s) => s.subordinateId === d.employeeId && s.relation === d.relation),
    ),
    orgRoles: duties.orgRoles.filter((d) => !succeeded.some((s) => s.orgId === d.orgId && s.role === d.role)),
  };
  return { linkage, dutyTransfer };
}
