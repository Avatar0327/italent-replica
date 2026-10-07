import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf } from './store.js';

/** F-026：按有效区间内已配置的周期、容量/方案版本及行政树边界分段；各段再扫描人员峰值。 */
export async function assessmentDates(tx: Tx, tenantId: string, from: string, until: string | null) {
  const rows = rowsOf<{ day: string }>(
    await tx.execute(sql`
    SELECT DISTINCT day::text AS day FROM (
      SELECT period_start AS day FROM establishment_objects WHERE tenant_id=${tenantId}
      UNION SELECT period_end+1 FROM establishment_objects WHERE tenant_id=${tenantId}
      UNION SELECT start_date FROM establishment_versions WHERE tenant_id=${tenantId}
      UNION SELECT start_date FROM establishment_scheme_versions WHERE tenant_id=${tenantId}
      UNION SELECT stop_date+1 FROM establishment_scheme_versions WHERE tenant_id=${tenantId} AND stop_date<'9999-12-31'
      UNION SELECT start_date FROM org_versions WHERE tenant_id=${tenantId}
    ) boundaries
    WHERE day>${from}::date AND day<'9999-12-31'::date
      AND (${until}::date IS NULL OR day<${until}::date)
    ORDER BY day LIMIT 1001
  `),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '编制校验区间变化超过处理上限');
  return [from, ...rows.map((row) => row.day)];
}
