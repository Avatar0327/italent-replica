import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

/**
 * DEC-089：组织 / 职务排序号是全租户名次（G-036 / DEC-037：组织按行政路径的顺序号 + 编码，职务按编码），
 * 由迁移 0026 的触发器在组织 / 职务变更的同一事务内按生效区间预计算存储；读取只按业务日期取所在区间，
 * 不再递归遍历组织树。停用、失效或不在行政树上的组织 / 职务没有名次。
 */
export function sortRankJoins(asOf: string): SQL {
  return sql`LEFT JOIN personnel_org_sort_ranks org_rank ON org_rank.tenant_id=e.tenant_id
      AND org_rank.org_id=(r.current_fields->>'department_id')::uuid
      AND org_rank.valid_from<=${asOf}::date AND org_rank.valid_to>${asOf}::date
    LEFT JOIN personnel_post_sort_ranks post_rank ON post_rank.tenant_id=e.tenant_id
      AND post_rank.post_id=(r.current_fields->>'post_id')::uuid
      AND post_rank.valid_from<=${asOf}::date AND post_rank.valid_to>${asOf}::date`;
}
export const sortRankColumns = sql`org_rank.sort_number AS organization_sort_number,
  post_rank.sort_number AS post_sort_number`;
