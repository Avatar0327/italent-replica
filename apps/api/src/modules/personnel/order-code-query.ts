import { sql } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { PersonnelContext } from './store.js';

/** DEC-170 / 171：只在已配置启用规则时计算；候选只读取主职快照与规则需要的属性。 */
export function orderCodeProjection(ctx: PersonnelContext, order: SQL[]): SQL {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`WITH RECURSIVE cur_org AS (
    SELECT DISTINCT ON (org_id) id,org_id,enabled,stop_date FROM org_versions
    WHERE tenant_id=${ctx.tenantId} AND start_date<=${asOf}::date
    ORDER BY org_id,start_date DESC,version_no DESC
  ), paths(org_id,path,visited) AS (
    SELECT org_id,ARRAY[]::int[],ARRAY[org_id] FROM cur_org
    WHERE org_id=${ctx.tenantId}::uuid AND enabled AND stop_date>=${asOf}::date
    UNION ALL
    SELECT c.org_id,p.path || h.sequence,p.visited || c.org_id FROM cur_org c
    JOIN org_hierarchy_links h ON h.tenant_id=${ctx.tenantId} AND h.version_id=c.id AND h.dimension='admin'
    JOIN paths p ON p.org_id=h.parent_org_id
    WHERE c.enabled AND c.stop_date>=${asOf}::date AND NOT c.org_id=ANY(p.visited)
  ), candidates AS (
    SELECT e.id,e.code,paths.path AS department_path,jpost.code COLLATE "C" AS post_code,
      jp.display_order AS position_order,jl.level AS level_number,jg.grade AS grade_number
    FROM employment_employees e
    JOIN LATERAL (
      SELECT r.*,COALESCE(p.body,to_jsonb(r)) AS current_fields FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1) p ON true
      WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.start_date<=${asOf}::date
      ORDER BY t.start_date DESC,t.sort_order DESC LIMIT 1
    ) r ON true
    ${jobJoin('job_position_versions', 'jp', 'position_id', asOf)}
    ${jobJoin('job_post_versions', 'jpost', 'post_id', asOf)}
    ${jobJoin('job_level_versions', 'jl', 'level_id', asOf)}
    ${jobJoin('job_grade_versions', 'jg', 'grade_id', asOf)}
    LEFT JOIN paths ON paths.org_id=(r.current_fields->>'department_id')::uuid
    WHERE e.tenant_id=${ctx.tenantId}
  ), ranked AS (
    SELECT id,rank() OVER (ORDER BY ${sql.join(order, sql`,`)})::int AS n FROM candidates
  ) SELECT e.id,r.n FROM employment_employees e LEFT JOIN ranked r ON r.id=e.id
    WHERE e.tenant_id=${ctx.tenantId}`;
}
function jobJoin(table: string, alias: string, field: string, asOf: string) {
  return sql`LEFT JOIN LATERAL (SELECT j.* FROM ${sql.identifier(table)} j WHERE j.tenant_id=e.tenant_id
    AND j.object_id=(r.current_fields->>${field})::uuid AND j.start_date<=${asOf}::date
    ORDER BY j.start_date DESC,j.version_no DESC LIMIT 1) ${sql.identifier(alias)} ON true`;
}
