import { onboardingPreparationScopeOrgs as scopeOrgs, sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { BusinessContext } from '../job/context.js';
import { resolveModuleScopeInTransaction, scopeSql, type ModuleScope } from '../permission/module-access.js';
import { rowsOf } from '../employment/read-model.js';

export const PREPARATION_SETTINGS = MODULE_OBJECTS.employmentSettings.code;

export const preparationConfigScope = (deps: TenantRouteDeps, tx: Tx, ctx: BusinessContext) =>
  resolveModuleScopeInTransaction(deps, ctx, tx, PREPARATION_SETTINGS);

export function preparationConfigMissing(): never {
  throw new AppError('NOT_FOUND', '准备配置或引用不存在');
}

function containsRoots(ctx: BusinessContext, scope: ModuleScope, roots: SQL) {
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

export function preparationRuleScope(ctx: BusinessContext, scope: ModuleScope, ruleId: SQL) {
  const roots = sql`SELECT ${scopeOrgs.orgId} FROM ${scopeOrgs}
    WHERE ${scopeOrgs.tenantId} = ${ctx.tenantId} AND ${scopeOrgs.ruleId} = ${ruleId}`;
  return sql`(EXISTS (${roots}) AND ${containsRoots(ctx, scope, roots)})`;
}

export async function requirePreparationRoots(tx: Tx, ctx: BusinessContext, scope: ModuleScope, orgIds: string[]) {
  const roots = sql`SELECT id FROM org_objects WHERE tenant_id = ${ctx.tenantId}
    AND id IN (${sql.join(
      orgIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`;
  const [row] = rowsOf<{ allowed: boolean }>(
    await tx.execute(sql`SELECT (SELECT count(*) FROM (${roots}) found) = ${orgIds.length}
      AND ${containsRoots(ctx, scope, roots)} AS allowed`),
  );
  if (!row?.allowed) preparationConfigMissing();
}
