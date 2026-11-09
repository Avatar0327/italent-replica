/**
 * 组织在岗人数（F-474-2b #1，DEC-778②；docs/02_业务建模/18 §11、10 §统计字段）。
 *
 * 口径照北森「组织架构图 - 在岗人数」：只算主职、人员状态为试用 / 正式、数据日期当天有效的任职记录，含下级。
 * 租户级“在岗人数统计范围”设置（雇佣关系 / 用工形式等筛选）尚未做，按不过滤处理（见任务结果“未决/假设”）。
 * 范围：按查看人的组织范围计数（与组织列表同一份 ModuleScope，SQL 侧谓词，只按任职部门判定：不传人员列，
 * 否则管理范围项会再叠一道人员范围条件，与组织列表的口径不一致）。使用人范围（using_user）看的是组织的创建人，
 * 所以另传“任职部门这个组织的创建人”列，口径与组织列表同为组织对象 org.create 的创建人；
 * 不改成按人员的创建人过滤。范围外的人不计入——
 * 可见节点的人数只含范围内人员，范围外节点不出现，不留计数侧信道。
 * 不读继任统计缓存 succession_org_stats（DEC-778②）：每次现算。
 * 一个人同一时点只有一条主职任职，所以按部门直接计数后沿层级累加不会重复计人。
 */
import { sql, type Tx } from '@italent/db';
import type { OrgDimension } from '@italent/domain';
import { EMPLOYEE_STATUS } from '@italent/domain';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';
import { creatorSql } from '../permission/scope-audit.js';
import { rowsOf } from './read-model.js';

/** 北森口径：试用或正式。 */
const COUNTED_STATUSES = [EMPLOYEE_STATUS.probation, EMPLOYEE_STATUS.regular];

export interface DimensionEdges {
  readonly children: ReadonlyMap<string, string[]>;
  readonly parentOf: ReadonlyMap<string, string>;
}

/**
 * 各组织在 asOf 当天、所选维度下的上下级关系（含已停用，只要版本在查询日有效，不按查看人范围裁剪）：
 * 在岗人数逐级累加、组织树把可见节点挂到最近的可见祖先都用它；它只在服务端使用，不直接返回给调用方。
 */
export async function loadDimensionEdges(
  tx: Tx,
  tenantId: string,
  asOf: string,
  dimension: OrgDimension,
): Promise<DimensionEdges> {
  const rows = rowsOf<{ orgId: string; parentId: string }>(
    await tx.execute(sql`
      SELECT v.org_id AS "orgId", l.parent_org_id AS "parentId"
      FROM (SELECT DISTINCT ON (org_id) id, org_id, stop_date FROM org_versions
        WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
        ORDER BY org_id, start_date DESC, version_no DESC) v
      JOIN org_hierarchy_links l ON l.tenant_id = ${tenantId} AND l.version_id = v.id AND l.dimension = ${dimension}
      WHERE v.stop_date >= ${asOf}::date AND l.parent_org_id IS NOT NULL`),
  );
  const children = new Map<string, string[]>();
  for (const { orgId, parentId } of rows) children.set(parentId, [...(children.get(parentId) ?? []), orgId]);
  return { children, parentOf: new Map(rows.map((row) => [row.orgId, row.parentId])) };
}

/** 范围内人员按任职部门直接计数（不含下级）。 */
async function directCounts(tx: Tx, tenantId: string, asOf: string, scope: ModuleScope) {
  const department = sql`(CASE WHEN latest.id IS NULL THEN r.department_id ELSE latest.department_id END)`;
  const creator = creatorSql(tenantId, department, 'org.create', 'organization');
  const rows = rowsOf<{ orgId: string; n: number }>(
    await tx.execute(sql`
      SELECT ${department} AS "orgId", count(DISTINCT t.employee_id)::int AS n
      FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.id = t.record_id
      LEFT JOIN LATERAL (SELECT p.id, p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id = r.tenant_id AND p.business_id = r.id AND p.employee_id = r.employee_id
          AND p.is_record_snapshot ORDER BY p.version_no DESC LIMIT 1) latest ON true
      JOIN LATERAL employment_record_status(t.tenant_id, r.id) s ON true
      WHERE t.tenant_id = ${tenantId}::uuid AND t.valid_during @> ${asOf}::date
        AND r.service_type = 'primary' AND s.employee_status IN (${sql.join(COUNTED_STATUSES, sql`, `)})
        AND ${scopeSql(scope, { org: department, creator })}
      GROUP BY 1`),
  );
  return new Map(rows.filter((row) => row.orgId).map((row) => [row.orgId, Number(row.n)]));
}

/** 防御：层级校验保证各时点无环；仍按路径防环，异常数据只会少算，不会死循环。memo 在多个组织间共用。 */
function rollUpper(direct: ReadonlyMap<string, number>, children: ReadonlyMap<string, string[]>) {
  const memo = new Map<string, number>();
  const visit = (id: string, path: ReadonlySet<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const next = new Set(path).add(id);
    let total = direct.get(id) ?? 0;
    for (const child of children.get(id) ?? []) if (!next.has(child)) total += visit(child, next);
    memo.set(id, total);
    return total;
  };
  return (id: string) => visit(id, new Set());
}

export interface HeadcountQuery {
  readonly tenantId: string;
  readonly asOf: string;
  readonly dimension: OrgDimension;
  readonly scope: ModuleScope;
}

/** 返回给定组织（含下级、按查看人范围）的在岗人数；一次计数查询 + 一次层级查询（可传入已加载的），与组织数无关。 */
export async function readHeadcounts(tx: Tx, query: HeadcountQuery, orgIds: readonly string[], edges?: DimensionEdges) {
  const result = new Map<string, number>();
  if (!orgIds.length) return result;
  const direct = await directCounts(tx, query.tenantId, query.asOf, query.scope);
  const { children } = edges ?? (await loadDimensionEdges(tx, query.tenantId, query.asOf, query.dimension));
  const total = rollUpper(direct, children);
  for (const orgId of orgIds) result.set(orgId, total(orgId));
  return result;
}
