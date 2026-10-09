/**
 * 向下公开（DEC-026；IDP 🟡 K-23；R3-T02 设计 §1.3 由 IDP 抽为公共，行为不变）：对象的所属组织是查看人范围内某个
 * 组织的上级时，查看人可查看与选用、不能修改。只读放宽只用于业务读取；审计查看规则不因向下公开放宽（设计 §5.1）。
 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { tenantLocalDate } from '@italent/domain';
import { scopeSql } from './module-access.js';
import type { ModuleScope } from './scope-types.js';

/** 按租户时区取“当天”的组织版本所需的请求上下文。 */
export interface PublicDownContext {
  readonly tenantId: string;
  readonly now: Date;
  readonly timezone: string;
}

/** 范围内组织（按组织维度展开后的组织 ID）：只认管理 / 组织两个维度。 */
function scopeOrgIds(scope: ModuleScope): string[] {
  const terms = scope.terms ?? [{ dimension: 'management', orgIds: scope.orgIds, personIds: scope.personIds }];
  const ids = new Set<string>();
  for (const term of terms) {
    if (term.dimension === 'management' || term.dimension === 'organization') term.orgIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}

/**
 * 向下公开：对象的所属组织是查看人范围内某个组织的上级或其本身（行政维度，按租户时区当天的组织版本）。
 * 范围内组织为空时恒为 false；向上最多递归 64 层（防御性边界）。
 */
export function publicDownSql(ctx: PublicDownContext, scope: ModuleScope, org: SQL): SQL {
  const ids = scopeOrgIds(scope);
  if (!ids.length) return sql`false`;
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`${org} IN (
    WITH RECURSIVE up(org_id, depth) AS (
      SELECT unnest(${`{${ids.join(',')}}`}::uuid[]), 0
      UNION
      SELECT l.parent_org_id, up.depth + 1 FROM up
      CROSS JOIN LATERAL (
        SELECT v.id FROM org_versions v
        WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.org_id = up.org_id AND v.start_date <= ${asOf}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
      ) cv
      JOIN org_hierarchy_links l ON l.tenant_id = ${ctx.tenantId}::uuid AND l.version_id = cv.id
        AND l.dimension = 'admin'
      WHERE up.depth < 64
    ) SELECT org_id FROM up)`;
}

/**
 * 列表的 SQL 侧范围谓词（分页之前生效）：所属组织在范围内、命中创建人，或向下公开且范围内有其下级组织。
 * 别名列由调用方给出（如 sql`p.org_id`）。
 */
export function readableSql(
  ctx: PublicDownContext,
  scope: ModuleScope,
  columns: { org: SQL; publicDown: SQL; creator: SQL },
): SQL {
  if (scope.all) return sql`true`;
  return sql`(${scopeSql(scope, { org: columns.org, creator: columns.creator })}
    OR (${columns.publicDown} AND ${publicDownSql(ctx, scope, columns.org)}))`;
}
