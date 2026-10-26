/** DEC-691：保存、候选与解析共用来源引用和维度判断；不把当前状态当作历史业务日。 */
import { sql, type Tx } from '@italent/db';
import { relationSource, SOURCE_DIMENSIONS, type ApproverSource, type RelationSourceType } from '@italent/domain';
import { readOrgSettings } from '../org/settings.js';
import { approvalError, rowsOf } from './context.js';

type Dimension = (typeof SOURCE_DIMENSIONS)[keyof typeof SOURCE_DIMENSIONS];
export const sourceDimension = (type: RelationSourceType) => SOURCE_DIMENSIONS[type as keyof typeof SOURCE_DIMENSIONS];
export async function dimensionEnabled(tx: Tx, tenantId: string, dimension: Dimension | undefined) {
  return !dimension || (await readOrgSettings(tx, tenantId)).enabledDimensions.includes(dimension);
}
export function sourceTable(type: RelationSourceType) {
  return sourceDimension(type) ? 'org_objects' : type === 'position' ? 'job_position_objects' : 'job_post_objects';
}
export async function assertSourceReferences(tx: Tx, tenantId: string, sources: readonly ApproverSource[]) {
  for (const source of sources) {
    const ref = relationSource(source);
    if (!ref) continue;
    if (!(await dimensionEnabled(tx, tenantId, ref.dimension)))
      throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_DIMENSION_DISABLED', '审批来源的组织维度未启用');
    const [row] = rowsOf(
      await tx.execute(sql`SELECT id FROM ${sql.identifier(sourceTable(ref.type))}
      WHERE tenant_id=${tenantId} AND id=${ref.id}::uuid LIMIT 1`),
    );
    if (!row)
      throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_REFERENCE_INVALID', '审批来源引用不存在或不可用');
  }
}

/** 先选该业务日最新版本；停用 / 失效仍保留父链供向上穿越，未来版本不参与。 */
export function orgReferenceRows(tenantId: string, asOf: string, dimension: Dimension) {
  return sql`SELECT v.org_id AS id,v.name,(v.enabled AND v.stop_date>=${asOf}::date) AS enabled,
      h.parent_org_id AS parent_id,v.person_in_charge_id AS head_id
    FROM (SELECT DISTINCT ON (org_id) * FROM org_versions
      WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY org_id,start_date DESC,version_no DESC) v
    LEFT JOIN org_hierarchy_links h ON h.tenant_id=v.tenant_id AND h.version_id=v.id AND h.dimension=${dimension}`;
}
export function jobReferenceRows(tenantId: string, asOf: string, type: 'position' | 'job') {
  const table = sql.identifier(type === 'position' ? 'job_position_versions' : 'job_post_versions');
  const parent = type === 'position' ? sql`v.org_id` : sql`NULL::uuid`;
  return sql`SELECT v.object_id AS id,v.name,(v.enabled AND v.stop_date>=${asOf}::date) AS enabled,
      ${parent} AS parent_id FROM (SELECT DISTINCT ON (object_id) * FROM ${table}
      WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date
      ORDER BY object_id,start_date DESC,version_no DESC) v`;
}
