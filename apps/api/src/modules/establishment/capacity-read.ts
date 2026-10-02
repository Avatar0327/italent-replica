import {
  and,
  desc,
  eq,
  establishmentObjects,
  establishmentSubdivisions,
  establishmentVersions,
  sql,
  lte,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { subtreeIds } from './org-reader.js';
import { loadScheme } from './schemes.js';
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
  filters: { orgId?: string; schemeId?: string; periodStart?: string },
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
  const items: CapacityRecord[] = [];
  for (const row of rows) items.push(await readCapacity(tx, tenantId, row.id, asOf));
  return items;
}
