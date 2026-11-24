import { and, eq, inArray, onboardingCollectionScopeOrgs, orgObjects, sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import type { BusinessContext } from '../job/context.js';
import { resolveModuleScopeInTransaction, scopeSql, type ModuleScope } from '../permission/module-access.js';
import type { TenantRouteDeps } from '../../routes.js';

const scopeOrgs = onboardingCollectionScopeOrgs;
export const SETTINGS = MODULE_OBJECTS.employmentSettings.code;

export function collectionScope(deps: TenantRouteDeps, tx: Tx, ctx: BusinessContext) {
  return resolveModuleScopeInTransaction(deps, ctx, tx, SETTINGS);
}

export function configMissing(): never {
  throw new AppError('NOT_FOUND', '采集配置不存在');
}

/** 管理端能配置的组织范围须覆盖实际命中的行政子树，列表在 LIMIT 前使用同一判定。 */
function visibleRoots(ctx: BusinessContext, scope: ModuleScope, roots: SQL) {
  if (scope.all) return sql`true`;
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`NOT EXISTS (
    WITH RECURSIVE current_versions AS (
      SELECT DISTINCT ON (org_id) id, org_id, stop_date FROM org_versions
      WHERE tenant_id = ${ctx.tenantId} AND start_date <= ${today}::date
      ORDER BY org_id, start_date DESC, version_no DESC
    ), region(org_id) AS (
      ${roots}
      UNION
      SELECT v.org_id FROM region r
      JOIN org_hierarchy_links h ON h.tenant_id = ${ctx.tenantId} AND h.dimension = 'admin'
        AND h.parent_org_id = r.org_id
      JOIN current_versions v ON v.id = h.version_id AND v.stop_date >= ${today}::date
    )
    SELECT 1 FROM region WHERE NOT ${scopeSql(scope, { org: sql`region.org_id` })}
  )`;
}

export function ruleScopeSql(ctx: BusinessContext, scope: ModuleScope, rule: SQL) {
  const roots = sql`SELECT ${scopeOrgs.orgId} FROM ${scopeOrgs}
    WHERE ${scopeOrgs.tenantId} = ${ctx.tenantId} AND ${scopeOrgs.ruleId} = ${rule}`;
  return sql`(EXISTS (${roots}) AND ${visibleRoots(ctx, scope, roots)})`;
}

export async function requireCollectionOrgScope(tx: Tx, ctx: BusinessContext, scope: ModuleScope, orgIds: string[]) {
  const roots = tx
    .select({ id: orgObjects.id })
    .from(orgObjects)
    .where(and(eq(orgObjects.tenantId, ctx.tenantId), inArray(orgObjects.id, orgIds)));
  const found = await roots;
  if (found.length !== orgIds.length) configMissing();
  const [row] = await tx
    .select({ allowed: visibleRoots(ctx, scope, roots.getSQL()) })
    .from(orgObjects)
    .where(and(eq(orgObjects.tenantId, ctx.tenantId), eq(orgObjects.id, orgIds[0]!)));
  if (row?.allowed !== true) configMissing();
}
