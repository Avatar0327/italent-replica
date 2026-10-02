import { sql, type Tx } from '@italent/db';
import { capacityFor, type CapacityRecord } from './capacity-read.js';
import { parentOrg, subtreeIds } from './org-reader.js';
import { loadScheme } from './schemes.js';
import { invalid, rowsOf, type EstablishmentContext } from './store.js';

/** 含下级额度在数据库求和；本级维护模式累加所有后代本级数。 */
async function sumChildren(tx: Tx, ctx: EstablishmentContext, orgId: string, record: CapacityRecord) {
  const scheme = await loadScheme(tx, ctx.tenantId, record.schemeId, record.startDate);
  const scope =
    scheme.maintenanceMode === 'local'
      ? sql`o.org_id <> ${orgId}::uuid AND o.org_id = ANY(${`{${(
          await subtreeIds(tx, ctx.tenantId, orgId, record.startDate)
        ).join(',')}}`}::uuid[])`
      : sql`o.org_id IN (
        SELECT v.org_id FROM org_current v JOIN org_hierarchy_links link
          ON link.tenant_id = ${ctx.tenantId} AND link.version_id = v.id
          AND link.dimension = 'admin' AND link.parent_org_id = ${orgId}::uuid
        WHERE v.stop_date >= ${record.startDate}::date
      )`;
  const amount = scheme.maintenanceMode === 'local' ? sql`local_capacity` : sql`inclusive_capacity`;
  const result = await tx.execute(sql`
    WITH org_current AS (
      SELECT DISTINCT ON (org_id) id, org_id, stop_date FROM org_versions
      WHERE tenant_id = ${ctx.tenantId} AND start_date <= ${record.startDate}::date
      ORDER BY org_id, start_date DESC, version_no DESC
    ), capacities AS (
      SELECT DISTINCT ON (v.object_id) v.local_capacity, v.inclusive_capacity
      FROM establishment_versions v JOIN establishment_objects o
        ON o.tenant_id = v.tenant_id AND o.id = v.object_id
      WHERE v.tenant_id = ${ctx.tenantId} AND v.start_date <= ${record.startDate}::date
        AND o.scheme_id = ${record.schemeId} AND o.period_start = ${record.periodStart}::date AND ${scope}
      ORDER BY v.object_id, v.start_date DESC, v.version_no DESC
    ) SELECT COALESCE(SUM(${amount}), 0)::text AS total FROM capacities
  `);
  return Number(rowsOf<{ total: string }>(result)[0]?.total ?? 0);
}

/** docs/18 §3 四条约束；在追加后检查，失败由命令事务或复制 savepoint 整体撤回。 */
export async function validateCapacity(tx: Tx, ctx: EstablishmentContext, record: CapacityRecord): Promise<void> {
  const local = record.localCapacity ?? 0;
  const inclusive = record.inclusiveCapacity ?? 0;
  if (inclusive < local) throw invalid('inclusiveCapacity', '含下级编制不得小于本级编制');
  const subdivisionLocal = record.subdivisions.reduce((sum, part) => sum + (part.localCapacity ?? 0), 0);
  const subdivisionInclusive = record.subdivisions.reduce((sum, part) => sum + (part.inclusiveCapacity ?? 0), 0);
  if (local < subdivisionLocal || inclusive < subdivisionInclusive) {
    throw invalid('subdivisions', '组织编制不得小于细分编制之和');
  }
  if (inclusive < local + (await sumChildren(tx, ctx, record.orgId, record))) {
    throw invalid('inclusiveCapacity', '含下级编制不得小于本级与直接下级含下级之和');
  }
  const parentId = await parentOrg(tx, ctx.tenantId, record.orgId, record.startDate);
  if (!parentId) return;
  const parent = await capacityFor(tx, ctx.tenantId, parentId, record.schemeId, record.periodStart, record.startDate);
  if (!parent) return;
  if ((await sumChildren(tx, ctx, parentId, record)) > (parent.inclusiveCapacity ?? 0) - (parent.localCapacity ?? 0)) {
    throw invalid('inclusiveCapacity', '兄弟部门含下级编制之和超过上级可分配编制');
  }
}
