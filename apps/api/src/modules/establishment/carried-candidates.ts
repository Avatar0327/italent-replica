import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf, type EstablishmentContext } from './store.js';

/** 只读取时点可用性元数据；不让未参与调编的未来/停用/排除对象进入授权及唯一性判断。 */
export async function carriedCandidates(
  tx: Tx,
  ctx: EstablishmentContext,
  orgIds: readonly string[],
  effectiveDate: string,
  today: string,
) {
  const records = rowsOf<{ id: string; orgId: string }>(
    await tx.execute(sql`
      SELECT o.id,o.org_id AS "orgId" FROM establishment_objects o
      JOIN LATERAL (
        SELECT v.id,v.enabled,v.stop_date FROM establishment_scheme_versions v
        WHERE v.tenant_id=o.tenant_id AND v.scheme_id=o.scheme_id AND v.start_date<=${today}::date
        ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1
      ) s ON s.enabled AND s.stop_date>=${today}::date
      WHERE o.tenant_id=${ctx.tenantId} AND o.org_id=ANY(${`{${orgIds.join(',')}}`}::uuid[])
        AND o.period_start<=${effectiveDate}::date AND o.period_end>=${effectiveDate}::date
        AND EXISTS (SELECT 1 FROM establishment_versions v WHERE v.tenant_id=o.tenant_id
          AND v.object_id=o.id AND v.start_date<=${today}::date)
        AND NOT EXISTS (SELECT 1 FROM establishment_scheme_exclusions e WHERE e.tenant_id=o.tenant_id
          AND e.version_id=s.id AND e.org_id=o.org_id)
      ORDER BY o.id LIMIT 1001`),
  );
  // 即使某一侧没有可用候选，也先检查组织范围，不能通过空集合泄露缺失/停用等配置。
  for (const orgId of new Set(orgIds)) {
    const candidates = records.filter((record) => record.orgId === orgId);
    for (const record of candidates.length ? candidates : [{ orgId }])
      await ctx.authorizeCapacityScope?.(tx, { ...record, operation: 'update' });
  }
  if (records.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '带编调动涉及的编制超过单次处理上限');
  return records;
}
