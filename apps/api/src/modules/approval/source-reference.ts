/** DEC-691：保存、候选与解析共用来源引用和维度判断；不把当前状态当作历史业务日。 */
import { sql, type Tx } from '@italent/db';
import { relationSource, SOURCE_DIMENSIONS, type ApproverSource, type RelationSourceType } from '@italent/domain';
import { readOrgSettings } from '../org/settings.js';
import { approvalError, rowsOf } from './context.js';

type Dimension = (typeof SOURCE_DIMENSIONS)[keyof typeof SOURCE_DIMENSIONS];
export const sourceDimension = (type: RelationSourceType) =>
  type in SOURCE_DIMENSIONS ? SOURCE_DIMENSIONS[type as keyof typeof SOURCE_DIMENSIONS] : undefined;
export async function dimensionEnabled(tx: Tx, tenantId: string, dimension: Dimension | undefined) {
  return !dimension || (await readOrgSettings(tx, tenantId)).enabledDimensions.includes(dimension);
}
export function sourceTable(type: RelationSourceType) {
  if (sourceDimension(type)) return 'org_objects';
  return type === 'position' ? 'job_position_objects' : 'job_post_objects';
}
/** DEC-691 D2/D7：v 是已选中的版本；行政组织不受扩展关系限制，租户根属于每个已启用维度。 */
function orgDimensionMember(tenantId: string, dimension: Dimension) {
  if (dimension === 'admin') return sql`true`;
  return sql`(v.org_id=${tenantId}::uuid OR EXISTS (
    SELECT 1 FROM org_hierarchy_links member WHERE member.tenant_id=v.tenant_id
      AND member.version_id=v.id AND member.dimension=${dimension}
  ))`;
}
export async function assertSourceReferences(tx: Tx, tenantId: string, sources: readonly ApproverSource[]) {
  for (const source of sources) {
    const ref = relationSource(source);
    if (!ref) continue;
    if (!(await dimensionEnabled(tx, tenantId, ref.dimension)))
      throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_DIMENSION_DISABLED', '审批来源的组织维度未启用');
    // 定义无申请业务日：允许任一日可选中的历史成员版本，不能拿同日已被修订覆盖的旧版本充数。
    // 不筛 enabled / stop_date，DEC-691 D4 允许保存历史与停用引用；运行再按实际业务日选版本。
    const query =
      ref.dimension && ref.dimension !== 'admin'
        ? sql`SELECT v.org_id AS id FROM (
            SELECT DISTINCT ON (start_date) id,tenant_id,org_id FROM org_versions
            WHERE tenant_id=${tenantId} AND org_id=${ref.id}::uuid
            ORDER BY start_date DESC,version_no DESC
          ) v WHERE ${orgDimensionMember(tenantId, ref.dimension)} LIMIT 1`
        : sql`SELECT id FROM ${sql.identifier(sourceTable(ref.type))}
            WHERE tenant_id=${tenantId} AND id=${ref.id}::uuid LIMIT 1`;
    const [row] = rowsOf(await tx.execute(query));
    if (!row)
      throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_REFERENCE_INVALID', '审批来源引用不存在或不可用');
  }
}

/** DEC-696：先按生效日选规范版本，再借最近成员版本的边；不把已被同日修订撤销的边复活。 */
function historicalParent(tenantId: string, asOf: string, dimension: Dimension) {
  return sql`SELECT link.parent_org_id FROM (
    SELECT DISTINCT ON (start_date) id,start_date FROM org_versions
    WHERE tenant_id=${tenantId} AND org_id=v.org_id AND start_date<=${asOf}::date
    ORDER BY start_date DESC,version_no DESC
  ) canonical JOIN org_hierarchy_links link ON link.tenant_id=${tenantId}
    AND link.version_id=canonical.id AND link.dimension=${dimension}
  ORDER BY canonical.start_date DESC LIMIT 1`;
}
/** 候选只读当日成员；运行可加载退出节点作祖先跳板，不能用它作种子、后代或取负责人。 */
export function orgReferenceRows(tenantId: string, asOf: string, dimension: Dimension, traverseExited = false) {
  const member = orgDimensionMember(tenantId, dimension);
  const history = traverseExited && dimension !== 'admin';
  const parent = history
    ? sql`CASE WHEN ${member} THEN h.parent_org_id ELSE past.parent_org_id END`
    : sql`h.parent_org_id`;
  return sql`SELECT v.org_id AS id,v.name,(v.enabled AND v.stop_date>=${asOf}::date) AS enabled,
      ${parent} AS parent_id,v.person_in_charge_id AS head_id,${member} AS member
    FROM (SELECT DISTINCT ON (org_id) * FROM org_versions
      WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY org_id,start_date DESC,version_no DESC) v
    LEFT JOIN org_hierarchy_links h ON h.tenant_id=v.tenant_id AND h.version_id=v.id AND h.dimension=${dimension}
    ${history ? sql`LEFT JOIN LATERAL (${historicalParent(tenantId, asOf, dimension)}) past ON NOT (${member})` : sql``}
    WHERE ${traverseExited ? sql`true` : member}`;
}
export function jobReferenceRows(tenantId: string, asOf: string, type: 'position' | 'job') {
  const table = sql.identifier(type === 'position' ? 'job_position_versions' : 'job_post_versions');
  const parent = type === 'position' ? sql`v.org_id` : sql`NULL::uuid`;
  return sql`SELECT v.object_id AS id,v.name,(v.enabled AND v.stop_date>=${asOf}::date) AS enabled,
      ${parent} AS parent_id FROM (SELECT DISTINCT ON (object_id) * FROM ${table}
      WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY object_id,start_date DESC,version_no DESC) v`;
}
