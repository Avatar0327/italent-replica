import { and, desc, eq, inArray, lte, ne, orgHierarchyLinks, orgObjects, orgVersions, type Tx } from '@italent/db';
import type { OrgDimension } from '@italent/domain';

export interface OrgParent {
  readonly parentId: string | null;
  readonly sequence: number | null;
}

export interface OrgRecord extends Omit<typeof orgVersions.$inferSelect, 'id' | 'orgId'> {
  readonly id: string;
  readonly versionId: string;
  readonly code: string;
  readonly revision: number;
  readonly parents: Partial<Record<OrgDimension, OrgParent>>;
}

export function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** SQL 先为每个组织选中时点最新版本，再仅加载命中版本的层级。 */
export async function loadOrgSnapshot(
  tx: Tx,
  tenantId: string,
  asOf: string,
  page?: { readonly limit: number; readonly offset: number },
): Promise<OrgRecord[]> {
  let query = tx
    .selectDistinctOn([orgVersions.orgId], { object: orgObjects, version: orgVersions })
    .from(orgVersions)
    .innerJoin(orgObjects, and(eq(orgObjects.id, orgVersions.orgId), eq(orgObjects.tenantId, orgVersions.tenantId)))
    .where(
      and(
        eq(orgVersions.tenantId, tenantId),
        lte(orgVersions.startDate, asOf),
        ...(page ? [ne(orgVersions.orgId, tenantId)] : []),
      ),
    )
    .orderBy(orgVersions.orgId, desc(orgVersions.startDate), desc(orgVersions.versionNo))
    .$dynamic();
  if (page) query = query.limit(page.limit).offset(page.offset);
  const rows = await query;
  const selected = rows.filter(({ version }) => version.stopDate >= asOf);
  const versionIds = selected.map(({ version }) => version.id);
  const links = versionIds.length
    ? await tx
        .select()
        .from(orgHierarchyLinks)
        .where(and(eq(orgHierarchyLinks.tenantId, tenantId), inArray(orgHierarchyLinks.versionId, versionIds)))
    : [];
  return selected.map(({ object, version }) => ({
    ...version,
    id: object.id,
    versionId: version.id,
    code: version.code,
    revision: object.revision,
    parents: Object.fromEntries(
      links
        .filter((link) => link.versionId === version.id)
        .map((link) => [link.dimension, { parentId: link.parentOrgId, sequence: link.sequence }]),
    ),
  }));
}

export function orderOrganizations(a: OrgRecord, b: OrgRecord): number {
  // TODO(需取证 Q-M0-07): DEC-037 长整数排序编码待明确组合算法与任务归属。
  const display = (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER);
  if (display) return display;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function displayOrganization(org: OrgRecord, startLevel: number): OrgRecord {
  return { ...org, fullName: org.fullName.split('/').slice(startLevel).join('/') };
}
