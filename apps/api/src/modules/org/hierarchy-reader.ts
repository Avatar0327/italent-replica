import { type Db, eq, isUuid, orgSettings, withTenant } from '@italent/db';
import {
  ORG_DIMENSIONS,
  type OrgDescendantsOptions,
  type OrgDescendantsQuery,
  type OrgDimension,
  type OrgEnabledQuery,
  type OrgHierarchyReader,
  type OrgId,
} from '@italent/domain';
import { loadOrgSnapshot, type OrgRecord, validIsoDate } from './read-model.js';

function validQuery(query: OrgEnabledQuery): boolean {
  return isUuid(query.tenantId) && validIsoDate(query.asOf);
}

function descendants(
  snapshot: readonly OrgRecord[],
  query: OrgDescendantsQuery,
  options: OrgDescendantsOptions,
): readonly OrgId[] {
  const root = snapshot.find((record) => record.id === query.orgId);
  if (!root || (!options.includeDisabled && !root.enabled)) return [];

  const children = new Map<string, OrgRecord[]>();
  for (const record of snapshot) {
    const parentId = record.parents[query.dimension]?.parentId;
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(record);
    children.set(parentId, siblings);
  }

  const seen = new Set<string>([query.orgId]);
  const pending: string[] = [query.orgId];
  const ids: OrgId[] = [];
  while (pending.length) {
    const parentId = pending.pop()!;
    for (const child of children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      // 契约 includeDisabled=false 要剪整棵停用子树，不能仅从最终列表隐藏停用节点。
      if (!options.includeDisabled && !child.enabled) continue;
      ids.push(child.id as OrgId);
      pending.push(child.id);
    }
  }
  return ids.sort();
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
        return descendants(await loadOrgSnapshot(tx, query.tenantId, query.asOf), query, options);
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
