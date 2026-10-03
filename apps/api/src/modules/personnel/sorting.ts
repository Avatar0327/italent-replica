import { sql } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { PersonnelContext } from './store.js';

/** G-036 / DEC-037：排序属性关联现行版本，组织依据行政路径、职务依据业务编码。 */
export function sortingCtes(ctx: PersonnelContext) {
  const date = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`WITH RECURSIVE personnel_org_current AS (
    SELECT DISTINCT ON (org_id) id,org_id,code,start_date,stop_date,enabled
    FROM org_versions WHERE tenant_id=${ctx.tenantId} AND start_date<=${date}::date
    ORDER BY org_id,start_date DESC,version_no DESC
  ), personnel_org_paths(org_id,sort_path,visited) AS (
    SELECT v.org_id,ARRAY[v.code]::text[],ARRAY[v.org_id] FROM personnel_org_current v
    WHERE v.org_id=${ctx.tenantId}::uuid AND v.enabled AND v.stop_date>=${date}::date
    UNION ALL
    SELECT v.org_id,p.sort_path || (lpad(COALESCE(h.sequence,2147483647)::text,10,'0') || ':' || v.code),
      p.visited || v.org_id
    FROM personnel_org_current v JOIN org_hierarchy_links h
      ON h.tenant_id=${ctx.tenantId} AND h.version_id=v.id AND h.dimension='admin'
    JOIN personnel_org_paths p ON p.org_id=h.parent_org_id
    WHERE v.enabled AND v.stop_date>=${date}::date AND NOT v.org_id=ANY(p.visited)
  ), personnel_org_ranks AS (
    SELECT org_id,row_number() OVER (ORDER BY sort_path)::integer AS sort_number FROM personnel_org_paths
  ), personnel_post_current AS (
    SELECT DISTINCT ON (object_id) object_id,code,stop_date,enabled FROM job_post_versions
    WHERE tenant_id=${ctx.tenantId} AND start_date<=${date}::date ORDER BY object_id,start_date DESC,version_no DESC
  ), personnel_post_ranks AS (
    SELECT object_id,row_number() OVER (ORDER BY code,object_id)::integer AS sort_number
    FROM personnel_post_current WHERE enabled AND stop_date>=${date}::date
  )`;
}
