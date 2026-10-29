import { sql, type Tx } from '@italent/db';
import { rowsOf } from '../record-store.js';

/** F255A / DEC-673：只在保存时派生；行政链跳过公司 / 部门，没有机构则回落租户根。
 * 时点沿用兼职引用校验的开始日，原站的历史 / 未来日期取值细节未验证。
 */
export async function partTimeInstitution(tx: Tx, tenantId: string, departmentId: string, asOf: string) {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    WITH RECURSIVE versions AS (
      SELECT DISTINCT ON (org_id) id, org_id, broad_type FROM org_versions
      WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC
    ), chain AS (
      SELECT v.*, ARRAY[v.org_id] AS path, 0 AS depth FROM versions v WHERE org_id=${departmentId}::uuid
      UNION ALL
      SELECT v.*, chain.path || v.org_id, chain.depth + 1 FROM chain
      JOIN org_hierarchy_links l ON l.tenant_id=${tenantId} AND l.version_id=chain.id AND l.dimension='admin'
      JOIN versions v ON v.org_id=l.parent_org_id
      WHERE chain.broad_type<>'机构' AND NOT v.org_id=ANY(chain.path) AND chain.depth<64
    )
    SELECT org_id AS id FROM chain WHERE broad_type='机构' ORDER BY depth LIMIT 1
  `),
  );
  return row?.id ?? tenantId;
}
