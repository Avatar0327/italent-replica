/** 组织新增按现行上级授权；原命令中的旧上级不能为改隶后的缓存结果继续授权。 */
import { and, eq, orgImportResults, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ScopeBusinessContext } from './module-contracts.js';
import { scopeAllows, type ModuleScope } from './module-access.js';
import { creatorOf, hasCreatorScope, visible } from './module-route-access.js';

export async function originalOrgImportRows(tx: Tx, tenantId: string, commandId: string) {
  return tx
    .select()
    .from(orgImportResults)
    .where(and(eq(orgImportResults.tenantId, tenantId), eq(orgImportResults.commandId, commandId)))
    .limit(100);
}

export async function authorizeOrgResult(
  tx: Tx,
  ctx: ScopeBusinessContext,
  scope: ModuleScope,
  id: string,
  created: boolean,
): Promise<void> {
  if (scope.all) return;
  const creator = hasCreatorScope(scope)
    ? await creatorOf(tx, ctx.tenantId, id, 'org.create', 'organization')
    : undefined;
  if (!created) return visible(scope, id, '组织不存在', creator);
  if (scopeAllows(scope, { orgId: id, creatorId: creator })) return;
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const result = await tx.execute(sql`
    SELECT h.parent_org_id AS "parentId" FROM org_hierarchy_links h
    WHERE h.tenant_id=${ctx.tenantId} AND h.version_id=(
      SELECT v.id FROM org_versions v WHERE v.tenant_id=${ctx.tenantId} AND v.org_id=${id}
      ORDER BY (v.start_date <= ${today}::date) DESC,
        CASE WHEN v.start_date <= ${today}::date THEN v.start_date END DESC,
        v.start_date ASC,v.version_no DESC LIMIT 1)
  `);
  // 未到首版生效日的新增按首版上级检查；已生效后始终使用权限当前日的上级。
  const parents = (Array.isArray(result) ? result : (result as { rows: { parentId: string | null }[] }).rows) as {
    parentId: string | null;
  }[];
  if (!parents.length) throw new AppError('NOT_FOUND', '组织不存在');
  for (const parent of parents) {
    visible(
      scope,
      parent.parentId ?? undefined,
      '组织不存在',
      hasCreatorScope(scope) && parent.parentId
        ? await creatorOf(tx, ctx.tenantId, parent.parentId, 'org.create', 'organization')
        : undefined,
    );
  }
}
