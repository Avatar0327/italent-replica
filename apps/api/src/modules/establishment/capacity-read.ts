import {
  and,
  desc,
  eq,
  establishmentObjects,
  establishmentSubdivisions,
  establishmentVersions,
  sql,
  inArray,
  lte,
  type Tx,
} from '@italent/db';
import { creatorSql } from '../permission/scope-audit.js';
import { scopeSql } from '../permission/module-access.js';
import { AppError } from '../../errors.js';
import { subtreeIds } from './org-reader.js';
import { loadScheme, loadSchemeBatch } from './schemes.js';
import { rowsOf } from './store.js';

export interface CapacityRecord extends Omit<typeof establishmentVersions.$inferSelect, 'id' | 'objectId'> {
  readonly id: string;
  readonly versionId: string;
  readonly revision: number;
  readonly orgId: string;
  readonly schemeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly effectiveDate: string;
  readonly subdivisions: readonly {
    positionId: string;
    localCapacity: number | null;
    inclusiveCapacity: number | null;
  }[];
}

export async function readCapacity(tx: Tx, tenantId: string, id: string, asOf: string): Promise<CapacityRecord> {
  const [row] = await tx
    .select({ object: establishmentObjects, version: establishmentVersions })
    .from(establishmentVersions)
    .innerJoin(
      establishmentObjects,
      and(
        eq(establishmentObjects.id, establishmentVersions.objectId),
        eq(establishmentObjects.tenantId, establishmentVersions.tenantId),
      ),
    )
    .where(
      and(
        eq(establishmentVersions.tenantId, tenantId),
        eq(establishmentVersions.objectId, id),
        lte(establishmentVersions.startDate, asOf),
      ),
    )
    .orderBy(desc(establishmentVersions.startDate), desc(establishmentVersions.versionNo))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', '编制在该时点不存在');
  const subdivisions = await tx
    .select()
    .from(establishmentSubdivisions)
    .where(
      and(eq(establishmentSubdivisions.tenantId, tenantId), eq(establishmentSubdivisions.versionId, row.version.id)),
    )
    .orderBy(establishmentSubdivisions.positionId)
    .limit(101);
  if (subdivisions.length > 100) throw new AppError('SERVICE_UNAVAILABLE', '单期职位细分超过处理上限');
  const scheme = await loadScheme(tx, tenantId, row.object.schemeId, asOf);
  const inclusiveCapacity =
    scheme.maintenanceMode === 'local' ? await sumLocal(tx, tenantId, row.object, asOf) : row.version.inclusiveCapacity;
  return {
    ...row.version,
    ...row.object,
    id: row.object.id,
    versionId: row.version.id,
    effectiveDate: row.version.startDate,
    startDate: row.version.startDate,
    inclusiveCapacity,
    subdivisions: subdivisions.map(({ positionId, localCapacity, inclusiveCapacity }) => ({
      positionId,
      localCapacity,
      inclusiveCapacity,
    })),
  };
}

async function sumLocal(tx: Tx, tenantId: string, object: typeof establishmentObjects.$inferSelect, asOf: string) {
  const ids = await subtreeIds(tx, tenantId, object.orgId, asOf);
  const result = await tx.execute(sql`
    WITH current_versions AS (
      SELECT DISTINCT ON (v.object_id) v.local_capacity FROM establishment_versions v
      JOIN establishment_objects o ON o.tenant_id = v.tenant_id AND o.id = v.object_id
      WHERE v.tenant_id = ${tenantId} AND v.start_date <= ${asOf}::date
        AND o.scheme_id = ${object.schemeId} AND o.period_start = ${object.periodStart}::date
        AND o.org_id = ANY(${`{${ids.join(',')}}`}::uuid[])
      ORDER BY v.object_id, v.start_date DESC, v.version_no DESC
    ) SELECT COALESCE(SUM(local_capacity), 0)::text AS total FROM current_versions
  `);
  return Number(rowsOf<{ total: string }>(result)[0]?.total ?? 0);
}

export async function capacityFor(
  tx: Tx,
  tenantId: string,
  orgId: string,
  schemeId: string,
  periodStart: string,
  asOf: string,
): Promise<CapacityRecord | null> {
  const [object] = await tx
    .select({ id: establishmentObjects.id })
    .from(establishmentObjects)
    .where(
      and(
        eq(establishmentObjects.tenantId, tenantId),
        eq(establishmentObjects.orgId, orgId),
        eq(establishmentObjects.schemeId, schemeId),
        eq(establishmentObjects.periodStart, periodStart),
      ),
    )
    .limit(1);
  if (!object) return null;
  try {
    return await readCapacity(tx, tenantId, object.id, asOf);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function listCapacities(
  tx: Tx,
  tenantId: string,
  asOf: string,
  filters: { orgId?: string; schemeId?: string; periodStart?: string; scope?: Parameters<typeof scopeSql>[0] },
  page: { limit: number; offset: number },
): Promise<CapacityRecord[]> {
  if (
    !Number.isInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 200 ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0
  ) {
    throw new AppError('VALIDATION_FAILED', '分页参数超出允许范围');
  }
  const conditions = [sql`o.tenant_id = ${tenantId}`];
  if (filters.scope)
    conditions.push(
      scopeSql(filters.scope, {
        org: sql`o.org_id`,
        creator: creatorSql(tenantId, sql`o.id`, 'establishment.capacity.create', 'establishment-capacity'),
      }),
    );
  if (filters.orgId) conditions.push(sql`o.org_id = ${filters.orgId}::uuid`);
  if (filters.schemeId) conditions.push(sql`o.scheme_id = ${filters.schemeId}::uuid`);
  if (filters.periodStart) conditions.push(sql`o.period_start = ${filters.periodStart}::date`);
  const result = await tx.execute(sql`
    SELECT o.id FROM establishment_objects o
    WHERE ${sql.join(conditions, sql` AND `)} AND EXISTS (
      SELECT 1 FROM establishment_versions v WHERE v.tenant_id = o.tenant_id
        AND v.object_id = o.id AND v.start_date <= ${asOf}::date
    ) ORDER BY o.period_start, o.org_id, o.id LIMIT ${page.limit} OFFSET ${page.offset}
  `);
  const rows = rowsOf<{ id: string }>(result);
  return readCapacityBatch(
    tx,
    tenantId,
    rows.map((row) => row.id),
    asOf,
  );
}

async function readCapacityBatch(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  asOf: string,
): Promise<CapacityRecord[]> {
  if (!ids.length) return [];
  const rows = await tx
    .selectDistinctOn([establishmentVersions.objectId], {
      object: establishmentObjects,
      version: establishmentVersions,
    })
    .from(establishmentVersions)
    .innerJoin(
      establishmentObjects,
      and(
        eq(establishmentObjects.id, establishmentVersions.objectId),
        eq(establishmentObjects.tenantId, establishmentVersions.tenantId),
      ),
    )
    .where(
      and(
        eq(establishmentVersions.tenantId, tenantId),
        inArray(establishmentVersions.objectId, [...ids]),
        lte(establishmentVersions.startDate, asOf),
      ),
    )
    .orderBy(
      establishmentVersions.objectId,
      desc(establishmentVersions.startDate),
      desc(establishmentVersions.versionNo),
    );
  const subdivisions = await batchSubdivisions(
    tx,
    tenantId,
    rows.map((row) => row.version.id),
  );
  const schemes = new Map(
    (await loadSchemeBatch(tx, tenantId, [...new Set(rows.map((row) => row.object.schemeId))], asOf)).map((scheme) => [
      scheme.id,
      scheme,
    ]),
  );
  const local = rows.filter((row) => schemes.get(row.object.schemeId)?.maintenanceMode === 'local');
  const sums = await batchLocalSums(
    tx,
    tenantId,
    local.map(({ object }) => object),
    asOf,
  );
  const byId = new Map(
    rows.map(({ object, version }) => {
      const scheme = schemes.get(object.schemeId);
      if (!scheme) throw new AppError('NOT_FOUND', '编制方案在该时点不存在');
      const children = subdivisions.filter((row) => row.versionId === version.id);
      if (children.length > 100) throw new AppError('SERVICE_UNAVAILABLE', '单期职位细分超过处理上限');
      return [
        object.id,
        {
          ...version,
          ...object,
          id: object.id,
          versionId: version.id,
          effectiveDate: version.startDate,
          startDate: version.startDate,
          inclusiveCapacity:
            scheme.maintenanceMode === 'local' ? (sums.get(object.id) ?? 0) : version.inclusiveCapacity,
          subdivisions: children.map(({ positionId, localCapacity, inclusiveCapacity }) => ({
            positionId,
            localCapacity,
            inclusiveCapacity,
          })),
        },
      ];
    }),
  );
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

async function batchLocalSums(
  tx: Tx,
  tenantId: string,
  local: readonly (typeof establishmentObjects.$inferSelect)[],
  asOf: string,
): Promise<Map<string, number>> {
  const sums = new Map<string, number>();
  if (local.length) {
    const values = sql.join(
      local.map(
        (object) =>
          sql`(${object.id}::uuid, ${object.orgId}::uuid, ${object.schemeId}::uuid, ${object.periodStart}::date)`,
      ),
      sql`, `,
    );
    const result = await tx.execute(sql`
      WITH RECURSIVE roots(capacity_id, org_id, scheme_id, period_start) AS (VALUES ${values}),
      orgs AS (
        SELECT DISTINCT ON (org_id) id,org_id,stop_date FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date ORDER BY org_id,start_date DESC,version_no DESC
      ), tree(capacity_id, org_id) AS (
        SELECT capacity_id,org_id FROM roots UNION
        SELECT tree.capacity_id,child.org_id FROM tree
        JOIN org_hierarchy_links link ON link.tenant_id=${tenantId}
          AND link.parent_org_id=tree.org_id AND link.dimension='admin'
        JOIN orgs child ON child.id=link.version_id AND child.stop_date>=${asOf}::date
      ), versions AS (
        SELECT DISTINCT ON (object_id) object_id,local_capacity FROM establishment_versions
        WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
        ORDER BY object_id,start_date DESC,version_no DESC
      )
      SELECT r.capacity_id AS id, COUNT(DISTINCT tree.org_id)::int AS count,
        COALESCE(SUM(v.local_capacity),0)::text AS total FROM roots r
      JOIN tree ON tree.capacity_id=r.capacity_id
      LEFT JOIN establishment_objects o ON o.tenant_id=${tenantId} AND o.org_id=tree.org_id
        AND o.scheme_id=r.scheme_id AND o.period_start=r.period_start
      LEFT JOIN versions v ON v.object_id=o.id GROUP BY r.capacity_id
    `);
    for (const row of rowsOf<{ id: string; count: number; total: string }>(result)) {
      if (row.count > 10001) throw new AppError('SERVICE_UNAVAILABLE', '组织行政范围超过单次处理预算');
      sums.set(row.id, Number(row.total));
    }
  }
  return sums;
}

async function batchSubdivisions(tx: Tx, tenantId: string, versionIds: string[]) {
  return tx
    .select()
    .from(establishmentSubdivisions)
    .where(
      and(eq(establishmentSubdivisions.tenantId, tenantId), inArray(establishmentSubdivisions.versionId, versionIds)),
    )
    .orderBy(establishmentSubdivisions.positionId)
    .limit(versionIds.length * 101);
}
