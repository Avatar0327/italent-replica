/** F-481 §4.3：没有联动执行行的直接调动也可以已生效；只复用任职的事实与队列谓词。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { pendingActivationState } from '../employment/activation-store.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';

export async function isTransferInForce(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<boolean> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, businessId, today);
  if (!record || record.kind !== 'transfer' || record.effectiveDate > today) return false;
  const [row] = rowsOf<{ pending: boolean; state: string }>(
    await tx.execute(sql`
    SELECT ${pendingActivationState(ctx.timezone)} AS pending,s.state FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
    WHERE b.tenant_id=${ctx.tenantId} AND b.id=${businessId}::uuid`),
  );
  return (
    !!row && !row.pending && !['deleted', 'rejected', 'disapproved', 'voided', 'draft', 'in_review'].includes(row.state)
  );
}
