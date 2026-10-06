/** F-007 / org/locks.ts：调动可能改写派生组织调整，须在组织/编制/实例锁之前固定其已有业务头。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export async function lockDerivedOrgAdjustmentHeads(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  sourceId: string,
) {
  const heads = rowsOf(
    await tx.execute(sql`
    SELECT b.id FROM employment_business_objects b
    JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id AND r.kind='org_adjustment'
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${employeeId}::uuid
      AND (SELECT kind FROM employment_payload_versions p WHERE p.tenant_id=${ctx.tenantId}
        AND p.business_id=${sourceId}::uuid ORDER BY p.version_no DESC LIMIT 1)='transfer'
    ORDER BY b.id LIMIT 1001 FOR UPDATE OF b
  `),
  );
  if (heads.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '派生组织调整超过单次处理上限');
}
