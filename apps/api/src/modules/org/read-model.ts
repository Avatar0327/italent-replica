import { and, desc, eq, orgHierarchyLinks, orgObjects, orgVersions, type Tx } from '@italent/db';
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

/** 最新版本先选中再判断失效日，不能把已失效的新版本回退成旧版本（10 §8.3）。 */
export async function loadOrgSnapshot(tx: Tx, tenantId: string, asOf: string): Promise<OrgRecord[]> {
  const rows = await tx
    .select({ object: orgObjects, version: orgVersions })
    .from(orgVersions)
    .innerJoin(orgObjects, and(eq(orgObjects.id, orgVersions.orgId), eq(orgObjects.tenantId, orgVersions.tenantId)))
    .where(and(eq(orgVersions.tenantId, tenantId)))
    .orderBy(desc(orgVersions.startDate), desc(orgVersions.versionNo));
  const selected = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.version.startDate <= asOf && !selected.has(row.object.id)) selected.set(row.object.id, row);
  }
  const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.tenantId, tenantId));
  return [...selected.values()]
    .filter(({ version }) => version.stopDate >= asOf)
    .map(({ object, version }) => ({
      ...version,
      id: object.id,
      versionId: version.id,
      code: object.code,
      revision: object.revision,
      parents: Object.fromEntries(
        links
          .filter((link) => link.versionId === version.id)
          .map((link) => [link.dimension, { parentId: link.parentOrgId, sequence: link.sequence }]),
      ),
    }));
}

export function orderOrganizations(a: OrgRecord, b: OrgRecord): number {
  const display = (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER);
  if (display) return display;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function displayOrganization(org: OrgRecord, startLevel: number): OrgRecord {
  return { ...org, fullName: org.fullName.split('/').slice(startLevel).join('/') };
}
