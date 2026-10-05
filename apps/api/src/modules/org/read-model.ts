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

export interface OrgPath {
  readonly fullName: string;
  readonly level: number;
}

/** 行政上级链的防御性深度上限；层级校验保证各时点无环，正常组织远达不到。 */
const MAX_PATH_DEPTH = 64;

export function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
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
  const paths = await resolveOrgPaths(tx, tenantId, asOf, versionIds);
  return selected.map(({ object, version }) => ({
    ...version,
    ...paths.get(version.id),
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

/**
 * DEC-021、`10` §16：全称与层级按查询日当天各级行政上级的名称逐级解析（原站下级不随上级改名分版本，按当天的上级名称
 * 显示），所以上级改名、移动或设立日期更正（DEC-147）都不给下级追加派生版本。上级当天已失效（只剩停用的下级挂着）时
 * 取它最后一个版本的名称，与失效前显示的一致（PR #54 第三轮复审 P3）。版本上存的全称只是写入时的路径，当天行政上级
 * 链不完整时（上级当天还不存在）才退回用它。按版本 ID 返回。
 */
export async function resolveOrgPaths(
  tx: Tx,
  tenantId: string,
  asOf: string,
  versionIds: readonly string[],
): Promise<Map<string, OrgPath>> {
  if (!versionIds.length) return new Map();
  const rows = rowsOf<{ versionId: string; fullName: string; level: number }>(
    await tx.execute(sql`
      WITH RECURSIVE chain(version_id, node_id, node_version_id, names, depth) AS (
        SELECT v.id, v.org_id, v.id, ARRAY[v.name]::text[], 0
        FROM org_versions v
        WHERE v.tenant_id=${tenantId} AND v.id = ANY(${`{${versionIds.join(',')}}`}::uuid[])
        UNION ALL
        SELECT c.version_id, p.org_id, p.id, array_prepend(p.name::text, c.names), c.depth + 1
        FROM chain c
        JOIN org_hierarchy_links l
          ON l.tenant_id=${tenantId} AND l.version_id=c.node_version_id AND l.dimension='admin'
        CROSS JOIN LATERAL (
          SELECT s.id, s.org_id, s.name FROM org_versions s
          WHERE s.tenant_id=${tenantId} AND s.org_id=l.parent_org_id AND s.start_date <= ${asOf}::date
          ORDER BY s.start_date DESC, s.version_no DESC LIMIT 1
        ) p
        WHERE c.node_id <> ${tenantId}::uuid AND c.depth < ${MAX_PATH_DEPTH}
      )
      SELECT version_id AS "versionId", array_to_string(names, '/') AS "fullName", depth AS level
      FROM chain WHERE node_id=${tenantId}::uuid
    `),
  );
  return new Map(rows.map((row) => [row.versionId, { fullName: row.fullName, level: Number(row.level) }]));
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

/** 某日及以后的全部版本边界（含该日）；环检查与 DEC-129 级联都按这些时点各算一次快照。 */
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
