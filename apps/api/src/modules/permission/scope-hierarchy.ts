import { sql, type Tx } from '@italent/db';
import type { OrgHierarchyReader, OrgId, OrgDimension } from '@italent/domain';
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

/** Request/transaction-local batched OrgHierarchyReader: one recursive query for all selected roots. */
export function scopeHierarchyReader(
  tx: Tx,
  tenantId: string,
  asOf: string,
  roots: readonly ScopeRoot[],
): OrgHierarchyReader {
  let result: Promise<{ root_id: string; dimension: string; org_id: string }[]> | undefined;
  const read = () =>
    (result ??= (async () => {
      if (!roots.length) return [];
      const values = roots.map(
        (root) => sql`(${root.orgId}::uuid,${root.dimension}::text,${root.includeDescendants}::boolean)`,
      );
      const rows = scopeRows<{ root_id: string; dimension: string; org_id: string }>(
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
      ), tree(root_id,dimension,expand,org_id) AS (
        SELECT q.org_id,q.dimension,q.expand,v.org_id FROM roots q JOIN current_versions v ON v.org_id=q.org_id

        UNION
        SELECT tree.root_id,tree.dimension,tree.expand,v.org_id FROM tree
        JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.dimension=tree.dimension
          AND h.parent_org_id=tree.org_id
        JOIN current_versions v ON v.id=h.version_id
        WHERE tree.expand
      ) SELECT root_id,dimension,org_id FROM tree LIMIT ${MAX_SCOPE_IDS + 1}
    `),
      );
      if (rows.length > MAX_SCOPE_IDS) throw new AppError('PAYLOAD_TOO_LARGE', '数据范围超过有界解析上限');
      return rows;
    })());
  const same = (q: { tenantId: string; asOf: string }) => q.tenantId === tenantId && q.asOf === asOf;
  return {
    async isEnabled(query) {
      if (!same(query)) return false;
      return (await read()).some((row) => row.root_id === query.orgId && row.org_id === query.orgId);
    },
    async listDescendantIds(query, options) {
      if (!options || options.includeDisabled !== false)
        throw new TypeError('Scope hierarchy requires includeDisabled:false');
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
    if (!(await reader.isEnabled(query))) continue;
    ids.add(root.orgId);
    if (root.includeDescendants) {
      // TODO(需取证 Q-M0-05): D-6 未决，停用组织及其子树暂按 fail-closed 排除。
      const descendants = await reader.listDescendantIds(
        { ...query, dimension: root.dimension as OrgDimension },
        { includeDisabled: false },
      );
      for (const id of descendants) ids.add(id);
    }
  }
  return [...ids];
}
