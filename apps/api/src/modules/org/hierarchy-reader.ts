import { type Db, eq, isUuid, orgSettings, sql, type Tx, withTenant } from '@italent/db';
import {
  ORG_DIMENSIONS,
  type OrgDescendantsOptions,
  type OrgDescendantsQuery,
  type OrgDimension,
  type OrgEnabledQuery,
  type OrgHierarchyReader,
  type OrgId,
} from '@italent/domain';
import { loadOrgSnapshot, validIsoDate } from './read-model.js';

function validQuery(query: OrgEnabledQuery): boolean {
  return isUuid(query.tenantId) && validIsoDate(query.asOf);
}

export async function listOrgDescendantsInTransaction(
  tx: Tx,
  query: OrgDescendantsQuery,
  options: OrgDescendantsOptions,
) {
  const result = await tx.execute(sql`
    WITH RECURSIVE current_versions AS (
      SELECT DISTINCT ON (org_id) id, org_id, enabled, stop_date
      FROM org_versions
      WHERE tenant_id = ${query.tenantId} AND start_date <= ${query.asOf}
      ORDER BY org_id, start_date DESC, version_no DESC
    ), tree AS (
      SELECT v.org_id, ARRAY[v.org_id]::uuid[] AS path
      FROM current_versions v
      WHERE v.org_id = ${query.orgId} AND v.stop_date >= ${query.asOf}
        AND (${options.includeDisabled} OR v.enabled)
      UNION ALL
      SELECT child.org_id, tree.path || child.org_id
      FROM tree
      JOIN org_hierarchy_links link ON link.tenant_id = ${query.tenantId}
        AND link.dimension = ${query.dimension} AND link.parent_org_id = tree.org_id
      JOIN current_versions child ON child.id = link.version_id AND child.stop_date >= ${query.asOf}
      WHERE (${options.includeDisabled} OR child.enabled) AND NOT child.org_id = ANY(tree.path)
    )
    SELECT org_id FROM tree WHERE org_id <> ${query.orgId} ORDER BY org_id
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: { org_id: string }[] }).rows) as {
    org_id: string;
  }[];
  return rows.map((row) => row.org_id as OrgId);
}

function extensionEnabled(settings: typeof orgSettings.$inferSelect | undefined, dimension: OrgDimension): boolean {
  if (dimension === 'admin') return true;
  if (!settings) return false;
  const flags = {
    business: settings.businessEnabled,
    product: settings.productEnabled,
    reserve4: settings.reserve4Enabled,
    reserve5: settings.reserve5Enabled,
  };
  return flags[dimension];
}

/** R1-T02 只读契约；与组织列表共用有效期版本快照，并且每次查询都走租户 RLS。 */
export function createOrgHierarchyReader(db: Db): OrgHierarchyReader {
  return {
    async listDescendantIds(query, options) {
      if (!options || typeof options.includeDisabled !== 'boolean') {
        throw new TypeError('listDescendantIds 必须显式传入 { includeDisabled: boolean }');
      }
      if (!validQuery(query) || !ORG_DIMENSIONS.some((dimension) => dimension === query.dimension)) return [];
      return withTenant(db, query.tenantId, async (tx) => {
        const [settings] = await tx.select().from(orgSettings).where(eq(orgSettings.tenantId, query.tenantId));
        if (!extensionEnabled(settings, query.dimension)) return [];
        return listOrgDescendantsInTransaction(tx, query, options);
      });
    },
    async isEnabled(query) {
      if (!validQuery(query)) return false;
      return withTenant(db, query.tenantId, async (tx) => {
        const snapshot = await loadOrgSnapshot(tx, query.tenantId, query.asOf);
        return snapshot.find((record) => record.id === query.orgId)?.enabled ?? false;
      });
    },
  };
}
