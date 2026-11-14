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
import { plannedTenant } from '../org/read-model.js';
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

/** 期间覆盖 day，且方案在 day 的最新版本未停用（与 loadSchemeBatch 的“该时点存在”同一判断）。 */
const covering = (day: string) => sql`o.period_start <= ${day}::date AND o.period_end >= ${day}::date
  AND EXISTS (
    SELECT 1 FROM (
      SELECT sv.stop_date FROM establishment_scheme_versions sv
      WHERE sv.tenant_id = o.tenant_id AND sv.scheme_id = o.scheme_id AND sv.start_date <= ${day}::date
      ORDER BY sv.start_date DESC, sv.version_no DESC LIMIT 1
    ) sv WHERE sv.stop_date >= ${day}::date
  )`;

export async function listCapacities(
  tx: Tx,
  tenantId: string,
  asOf: string,
  filters: {
    orgId?: string;
    schemeId?: string;
    periodStart?: string;
    scope?: Parameters<typeof scopeSql>[0];
    /** 只取期间覆盖该日、方案在该日有效的对象（人员流动看板 / 组织编制统计按时点取数用）。 */
    covering?: string;
  },
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
  if (filters.covering) conditions.push(covering(filters.covering));
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

/**
 * 只对这一条查询关掉顺序扫描，跑完还原原值（同一事务里后续查询照常规划）。为什么：统计信息齐全但分布偏斜时
 * （上万个下级挂在同一上级），规划器按“每个上级约半张表”估算，会把递归里逐步查下级改成顺序扫描，每一步滤掉
 * 整张链接表，1 万个下级约 1 亿行（F-476 P2 第 5 轮实测 7 s）；关掉后各步只能走索引，有无统计都随子树线性。
 * 查询出错时不在这里还原：事务（或所在保存点）随之回滚，SET LOCAL 也一并撤销；此时再发语句反会盖掉原错误。
 */
async function withoutSeqScan(tx: Tx, query: ReturnType<typeof sql>) {
  const [setting] = rowsOf<{ previous: string }>(
    await tx.execute(
      sql`SELECT current_setting('enable_seqscan') AS previous, set_config('enable_seqscan', 'off', true)`,
    ),
  );
  const result = await tx.execute(query);
  await tx.execute(sql`SELECT set_config('enable_seqscan', ${setting!.previous}, true)`);
  return result;
}

/** 编制对象在汇总里用到的键（组织调整预览按同一口径复用，BE-10e）。 */
export type LocalSumRoot = Pick<typeof establishmentObjects.$inferSelect, 'id' | 'orgId' | 'schemeId' | 'periodStart'>;

/**
 * “仅本级”方案的含下级 = 生效日行政子树（未停用）内同方案同期间的本级编制之和；按对象 ID 返回。
 * 汇总以文本取回再转数值，不在库里强转 int（多个本级之和可超过 int32）；子树超过预算时 503。
 */
export async function batchLocalSums(
  tx: Tx,
  tenantId: string,
  local: readonly LocalSumRoot[],
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
    // 租户条件写成参数，见 plannedTenant（新导入租户还不在统计里时，按版本 ID 取现行版本仍走 (租户, ID) 索引）。
    const tenant = plannedTenant(tenantId);
    // 递归每一步都从当前节点出发按索引查下级（LATERAL + OFFSET 0 / LIMIT 1 不让规划器改写成整表连接）：批量导入
    // 后统计信息还没收集时，规划器把层级链接估成 1 行，整表连接的写法退化成每步重扫工作表与全部现行版本，1 万个
    // 下级扫约 1 亿行（F-476 P2 第 5 轮实测）。查下级时 ORDER BY 与 org_hierarchy_tenant_parent 同序，无统计时
    // 规划器才会选这个索引，而不是按主键前缀扫全租户链接再过滤。下级须是它在 asOf 的现行版本且未失效，口径同前。
    const result = await withoutSeqScan(
      tx,
      sql`
      WITH RECURSIVE roots(capacity_id, org_id, scheme_id, period_start) AS (VALUES ${values}),
      tree(capacity_id, org_id) AS (
        SELECT capacity_id,org_id FROM roots UNION
        SELECT tree.capacity_id,child.org_id FROM tree
        CROSS JOIN LATERAL (
          SELECT link.version_id FROM org_hierarchy_links link
          WHERE link.tenant_id=${tenant} AND link.dimension='admin' AND link.parent_org_id=tree.org_id
          ORDER BY link.dimension,link.parent_org_id OFFSET 0
        ) link
        CROSS JOIN LATERAL (
          SELECT v.org_id FROM org_versions v
          WHERE v.tenant_id=${tenant} AND v.id=link.version_id
            AND v.start_date<=${asOf}::date AND v.stop_date>=${asOf}::date
            AND v.id=(
              SELECT s.id FROM org_versions s WHERE s.tenant_id=${tenant} AND s.org_id=v.org_id
                AND s.start_date<=${asOf}::date ORDER BY s.start_date DESC,s.version_no DESC LIMIT 1
            )
          OFFSET 0
        ) child
      )
      SELECT r.capacity_id AS id, COUNT(DISTINCT tree.org_id)::int AS count,
        COALESCE(SUM(v.local_capacity),0)::text AS total FROM roots r
      JOIN tree ON tree.capacity_id=r.capacity_id
      LEFT JOIN establishment_objects o ON o.tenant_id=${tenant} AND o.org_id=tree.org_id
        AND o.scheme_id=r.scheme_id AND o.period_start=r.period_start
      LEFT JOIN LATERAL (
        SELECT local_capacity FROM establishment_versions ev
        WHERE ev.tenant_id=${tenant} AND ev.object_id=o.id AND ev.start_date<=${asOf}::date
        ORDER BY ev.start_date DESC,ev.version_no DESC LIMIT 1
      ) v ON true
      GROUP BY r.capacity_id
    `,
    );
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
