import {
  and,
  desc,
  eq,
  inArray,
  lte,
  ne,
  orgHierarchyLinks,
  orgObjects,
  orgVersions,
  personnelOrgSortRanks,
  sql,
  type Tx,
} from '@italent/db';
import type { OrgDimension } from '@italent/domain';
import { creatorSql } from '../permission/scope-audit.js';
import { scopeSql } from '../permission/module-access.js';

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
  filter?: {
    readonly scope?: Parameters<typeof scopeSql>[0];
    readonly id?: string;
    readonly name?: string;
    readonly includeDisabled?: boolean;
    readonly dimension?: OrgDimension;
  },
): Promise<OrgRecord[]> {
  const rows = await orgSnapshotQuery(tx, tenantId, asOf, page, filter);
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

/** 每个组织在 asOf 当日的现行版本（分页时排除租户根组织）。 */
function currentOrgVersions(
  tx: Tx,
  tenantId: string,
  asOf: string,
  excludeRoot: boolean,
  filter: Parameters<typeof loadOrgSnapshot>[4],
) {
  return tx
    .selectDistinctOn([orgVersions.orgId])
    .from(orgVersions)
    .where(
      and(
        eq(orgVersions.tenantId, tenantId),
        lte(orgVersions.startDate, asOf),
        ...(excludeRoot ? [ne(orgVersions.orgId, tenantId)] : []),
        ...(filter?.scope
          ? [
              scopeSql(filter.scope, {
                org: sql`${orgVersions.orgId}`,
                creator: creatorSql(tenantId, sql`${orgVersions.orgId}`, 'org.create', 'organization'),
              }),
            ]
          : []),
        ...(filter?.id ? [eq(orgVersions.orgId, filter.id)] : []),
      ),
    )
    .orderBy(orgVersions.orgId, desc(orgVersions.startDate), desc(orgVersions.versionNo))
    .as('current_org');
}

function orgSnapshotQuery(
  tx: Tx,
  tenantId: string,
  asOf: string,
  page: Parameters<typeof loadOrgSnapshot>[3],
  filter: Parameters<typeof loadOrgSnapshot>[4],
) {
  const current = currentOrgVersions(tx, tenantId, asOf, Boolean(page), filter);
  let query = tx
    .select({
      object: orgObjects,
      version: {
        id: current.id,
        tenantId: current.tenantId,
        orgId: current.orgId,
        versionNo: current.versionNo,
        previousVersionId: current.previousVersionId,
        startDate: current.startDate,
        stopDate: current.stopDate,
        enabled: current.enabled,
        code: current.code,
        name: current.name,
        shortName: current.shortName,
        broadType: current.broadType,
        establishedOn: current.establishedOn,
        personInChargeId: current.personInChargeId,
        hrbpId: current.hrbpId,
        shopOwnerId: current.shopOwnerId,
        costCenterId: current.costCenterId,
        location: current.location,
        remarks: current.remarks,
        fullName: current.fullName,
        displayOrder: current.displayOrder,
        isVirtual: current.isVirtual,
        level: current.level,
        createdAt: current.createdAt,
      },
    })
    .from(current)
    .innerJoin(orgObjects, and(eq(orgObjects.id, current.orgId), eq(orgObjects.tenantId, current.tenantId)))
    .leftJoin(
      personnelOrgSortRanks,
      and(
        eq(personnelOrgSortRanks.tenantId, current.tenantId),
        eq(personnelOrgSortRanks.objectId, current.orgId),
        lte(personnelOrgSortRanks.validFrom, asOf),
        sql`${personnelOrgSortRanks.validTo} > ${asOf}::date`,
      ),
    )
    .where(
      and(
        sql`${current.stopDate} >= ${asOf}::date`,
        ...(filter?.name !== undefined ? [eq(current.name, filter.name)] : []),
        ...(filter?.includeDisabled === false ? [eq(current.enabled, true)] : []),
        ...(filter?.dimension && filter.dimension !== 'admin'
          ? [
              sql`EXISTS (
        SELECT 1 FROM org_hierarchy_links h WHERE h.tenant_id = ${tenantId}
        AND h.version_id = ${current.id} AND h.dimension = ${filter.dimension}
      )`,
            ]
          : []),
      ),
    )
    // DEC-089 / DEC-037（`15` §12 Q-M0-07）：组织的排序编码按名次口径，直接取迁移 0027 预计算并存储的组织名次
    // （行政路径上逐级比较行政维度顺序号、再比较编码），不现算、不拼长整数分段编码；停用或不在行政树上的组织
    // 没有名次，排在最后按编码。分页在 SQL 内完成，页内不再重排。
    .orderBy(sql`${personnelOrgSortRanks.sortNumber} ASC NULLS LAST`, current.code, orgObjects.id)
    .$dynamic();
  if (page) query = query.limit(page.limit).offset(page.offset);
  return query;
}

/** 某日及以后的全部版本边界（含该日）；全称同步、环检查与 DEC-129 级联都按这些时点各算一次快照。 */
export async function futureBoundaries(tx: Tx, tenantId: string, effectiveDate: string): Promise<string[]> {
  const versions = await tx
    .select({ startDate: orgVersions.startDate })
    .from(orgVersions)
    .where(eq(orgVersions.tenantId, tenantId));
  return [...new Set([effectiveDate, ...versions.map((row) => row.startDate)])]
    .filter((boundary) => boundary >= effectiveDate)
    .sort();
}

export function displayOrganization(org: OrgRecord, startLevel: number): OrgRecord {
  return { ...org, fullName: org.fullName.split('/').slice(startLevel).join('/') };
}
