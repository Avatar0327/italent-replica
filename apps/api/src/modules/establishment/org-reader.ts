import { and, desc, eq, isUuid, lte, orgHierarchyLinks, orgSettings, orgVersions, sql, type Tx } from '@italent/db';
import { ORG_DIMENSIONS, type OrgHierarchyReader, type OrgId } from '@italent/domain';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';
import { rowsOf } from './store.js';

/** 同事务实现既有契约，避免在占编事务内调用 Db 级 reader 再开启一个事务。 */
export function createTxOrgHierarchyReader(tx: Tx): OrgHierarchyReader {
  return {
    async isEnabled(query) {
      if (!isUuid(query.tenantId) || !isUuid(query.orgId) || !validIsoDate(query.asOf)) return false;
      const [version] = await tx
        .select()
        .from(orgVersions)
        .where(
          and(
            eq(orgVersions.tenantId, query.tenantId),
            eq(orgVersions.orgId, query.orgId),
            lte(orgVersions.startDate, query.asOf),
          ),
        )
        .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo))
        .limit(1);
      return !!version && version.stopDate >= query.asOf && version.enabled;
    },
    async listDescendantIds(query, options) {
      if (!options || typeof options.includeDisabled !== 'boolean') throw new TypeError('includeDisabled 必填');
      if (!isUuid(query.tenantId) || !isUuid(query.orgId) || !validIsoDate(query.asOf)) return [];
      if (!ORG_DIMENSIONS.includes(query.dimension)) return [];
      if (query.dimension !== 'admin') {
        const [settings] = await tx.select().from(orgSettings).where(eq(orgSettings.tenantId, query.tenantId));
        if (!settings?.[`${query.dimension}Enabled`]) return [];
      }
      const result = await tx.execute(sql`
        WITH RECURSIVE versions AS (
          SELECT DISTINCT ON (org_id) id, org_id, enabled, stop_date FROM org_versions
          WHERE tenant_id = ${query.tenantId} AND start_date <= ${query.asOf}
          ORDER BY org_id, start_date DESC, version_no DESC
        ), tree AS (
          SELECT org_id, ARRAY[org_id]::uuid[] path FROM versions
          WHERE org_id = ${query.orgId} AND stop_date >= ${query.asOf}
            AND (${options.includeDisabled} OR enabled)
          UNION ALL
          SELECT child.org_id, tree.path || child.org_id FROM tree
          JOIN org_hierarchy_links link ON link.tenant_id = ${query.tenantId}
            AND link.parent_org_id = tree.org_id AND link.dimension = ${query.dimension}
          JOIN versions child ON child.id = link.version_id AND child.stop_date >= ${query.asOf}
          WHERE (${options.includeDisabled} OR child.enabled) AND NOT child.org_id = ANY(tree.path)
        ) SELECT DISTINCT org_id FROM tree WHERE org_id <> ${query.orgId} ORDER BY org_id LIMIT 10001
      `);
      const rows = rowsOf<{ org_id: string }>(result);
      if (rows.length > 10000) throw new AppError('SERVICE_UNAVAILABLE', '组织行政范围超过单次处理预算');
      return rows.map((row) => row.org_id as OrgId);
    },
  };
}

export async function assertOrg(tx: Tx, tenantId: string, orgId: string, asOf: string): Promise<void> {
  if (!(await createTxOrgHierarchyReader(tx).isEnabled({ tenantId, orgId: orgId as OrgId, asOf }))) {
    throw new AppError('VALIDATION_FAILED', '组织不存在、停用或不在当前租户生效');
  }
}

export async function parentOrg(tx: Tx, tenantId: string, orgId: string, asOf: string): Promise<string | null> {
  const [version] = await tx
    .select({ id: orgVersions.id, stopDate: orgVersions.stopDate })
    .from(orgVersions)
    .where(and(eq(orgVersions.tenantId, tenantId), eq(orgVersions.orgId, orgId), lte(orgVersions.startDate, asOf)))
    .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo))
    .limit(1);
  if (!version || version.stopDate < asOf) return null;
  const [link] = await tx
    .select()
    .from(orgHierarchyLinks)
    .where(
      and(
        eq(orgHierarchyLinks.tenantId, tenantId),
        eq(orgHierarchyLinks.versionId, version.id),
        eq(orgHierarchyLinks.dimension, 'admin'),
      ),
    )
    .limit(1);
  return link?.parentOrgId ?? null;
}

export async function subtreeIds(tx: Tx, tenantId: string, orgId: string, asOf: string): Promise<string[]> {
  const ids = await createTxOrgHierarchyReader(tx).listDescendantIds(
    { tenantId, orgId: orgId as OrgId, dimension: 'admin', asOf },
    { includeDisabled: true },
  );
  return [orgId, ...ids];
}
