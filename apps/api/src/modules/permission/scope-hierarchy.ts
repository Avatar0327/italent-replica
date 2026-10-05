import { sql, type Tx } from '@italent/db';
import type { OrgEnabledQuery, OrgHierarchyReader, OrgId, OrgDimension } from '@italent/domain';
import { AppError } from '../../errors.js';
export interface ScopeRoot {
  readonly orgId: string;
  readonly dimension: string;
  readonly includeDescendants: boolean;
}
export function scopeRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
const MAX_SCOPE_IDS = 20_000;

interface ScopeTreeRow {
  root_id: string;
  dimension: string;
  org_id: string;
  enabled: boolean;
}

/**
 * Request/transaction-local batched OrgHierarchyReader: one recursive query for all selected roots.
 * DEC-146（`11` §18）：数据范围不因组织停用而收缩——停用的范围根、停用的下级及其子树都照常展开，
 * 所以这里只支持 includeDisabled:true；停用状态由 isEnabled 如实给出，但不参与范围判断。
 */
export function scopeHierarchyReader(
  tx: Tx,
  tenantId: string,
  asOf: string,
  roots: readonly ScopeRoot[],
): OrgHierarchyReader & { resolvesRoot(query: OrgEnabledQuery): Promise<boolean> } {
  let result: Promise<ScopeTreeRow[]> | undefined;
  const read = () =>
    (result ??= (async () => {
      if (!roots.length) return [];
      const values = roots.map(
        (root) => sql`(${root.orgId}::uuid,${root.dimension}::text,${root.includeDescendants}::boolean)`,
      );
      const rows = scopeRows<ScopeTreeRow>(
        await tx.execute(sql`
      WITH RECURSIVE requested(org_id,dimension,expand) AS (VALUES ${sql.join(values, sql`, `)}),
      current_versions AS (
        SELECT DISTINCT ON (org_id) id,org_id,enabled,stop_date FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
        ORDER BY org_id,start_date DESC,version_no DESC
      ), roots AS (
        SELECT q.* FROM requested q LEFT JOIN org_settings s ON s.tenant_id=${tenantId}
        WHERE CASE q.dimension WHEN 'admin' THEN true WHEN 'business' THEN s.business_enabled
          WHEN 'product' THEN s.product_enabled WHEN 'reserve4' THEN s.reserve4_enabled
          WHEN 'reserve5' THEN s.reserve5_enabled ELSE false END
      ), tree(root_id,dimension,expand,org_id,enabled) AS (
        SELECT q.org_id,q.dimension,q.expand,v.org_id,v.enabled FROM roots q
        JOIN current_versions v ON v.org_id=q.org_id
        UNION
        SELECT tree.root_id,tree.dimension,tree.expand,v.org_id,v.enabled FROM tree
        JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.dimension=tree.dimension
          AND h.parent_org_id=tree.org_id
        JOIN current_versions v ON v.id=h.version_id
        WHERE tree.expand
      ) SELECT root_id,dimension,org_id,enabled FROM tree LIMIT ${MAX_SCOPE_IDS + 1}
    `),
      );
      if (rows.length > MAX_SCOPE_IDS) throw new AppError('PAYLOAD_TOO_LARGE', '数据范围超过有界解析上限');
      return rows;
    })());
  const same = (q: { tenantId: string; asOf: string }) => q.tenantId === tenantId && q.asOf === asOf;
  const rootRow = async (query: OrgEnabledQuery) =>
    same(query) ? (await read()).find((row) => row.root_id === query.orgId && row.org_id === query.orgId) : undefined;
  return {
    /** 范围根在本租户、该日存在且维度已开启即纳入，不看启用状态（DEC-146）。 */
    async resolvesRoot(query) {
      return !!(await rootRow(query));
    },
    async isEnabled(query) {
      return (await rootRow(query))?.enabled === true;
    },
    async listDescendantIds(query, options) {
      if (!options || options.includeDisabled !== true)
        throw new TypeError('Scope hierarchy requires includeDisabled:true (DEC-146)');
      if (!same(query)) return [];
      return (await read())
        .filter((row) => row.root_id === query.orgId && row.dimension === query.dimension && row.org_id !== query.orgId)
        .map((row) => row.org_id as OrgId);
    },
  };
}

export async function expandScopeRoots(tx: Tx, tenantId: string, asOf: string, roots: readonly ScopeRoot[]) {
  if (roots.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '范围根节点最多 200 条');
  const reader = scopeHierarchyReader(tx, tenantId, asOf, roots);
  const ids = new Set<string>();
  for (const root of roots) {
    const query = { tenantId, asOf: asOf as `${number}-${number}-${number}`, orgId: root.orgId as OrgId };
    if (!(await reader.resolvesRoot(query))) continue;
    ids.add(root.orgId);
    if (root.includeDescendants) {
      // DEC-146（`11` §18，补全 DEC-083）：范围内的停用组织及其子树仍在范围内，停用不使范围收缩。
      const descendants = await reader.listDescendantIds(
        { ...query, dimension: root.dimension as OrgDimension },
        { includeDisabled: true },
      );
      for (const id of descendants) ids.add(id);
    }
  }
  return [...ids];
}
