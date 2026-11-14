/** DEC-691：流程编辑者的引用候选（含 D6 身份），只返回 ID / 名称 / 状态 / 父级；不暴露人员与授权成员。 */
import { sql, type Tx } from '@italent/db';
import {
  allowsSubjectEmployee,
  APPROVAL_TYPE_APPS,
  APPROVAL_TYPES,
  RELATION_SOURCE_TYPES,
  type ApprovalTypeCode,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';
import { approvalError, canonicalId, rowsOf } from './context.js';
import { dimensionEnabled, sourceDimension, orgReferenceRows, jobReferenceRows } from './source-reference.js';

const VARIABLE_TYPES = ['public_variable', 'application_variable'] as const;
/** 矩阵的角色列候选 id 是 `<矩阵>:<角色列>`（设计 §3.1 / §5.3），ids 回查两种写法都收；其余类型只收单个 UUID。 */
const candidateId = z
  .string()
  .refine((v) => v.split(':').length <= 2 && v.split(':').every((part) => z.uuid().safeParse(part).success))
  .transform((v) => v.split(':').map(canonicalId).join(':'));

const querySchema = z.object({
  type: z.enum([...RELATION_SOURCE_TYPES, 'identity', 'object_field', ...VARIABLE_TYPES, 'matrix']),
  approvalType: z.enum(Object.keys(APPROVAL_TYPES) as [ApprovalTypeCode, ...ApprovalTypeCode[]]).optional(),
  asOf: z.string().refine(validIsoDate),
  keyword: z.string().trim().max(100).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).max(5000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  ids: z
    .string()
    .transform((v) => v.split(','))
    .pipe(z.array(candidateId).min(1).max(100))
    .optional(),
});
export function designerSourcesQuery(query: Record<string, string>) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '审批来源候选查询参数不合法');
  const { type, ids, approvalType } = parsed.data;
  // 应用变量按审批类型所属应用过滤，不带类型就没有范围（设计 §5.3）；组合 id 只属于矩阵
  const invalid =
    (type === 'application_variable' && !approvalType) || (type !== 'matrix' && ids?.some((id) => id.includes(':')));
  if (invalid) throw new AppError('VALIDATION_FAILED', '审批来源候选查询参数不合法');
  return parsed.data;
}
/**
 * 命名来源（没有库表对象，id 即来源值）：系统管理员适用任一类型；主体员工本人只给单主体类型（设计 §8.2）；
 * 返聘后直线经理只给退休类型，选了别的类型保存时 422（设计 §5.3）。
 */
function namedRows(query: ReturnType<typeof designerSourcesQuery>) {
  const type = query.approvalType ? APPROVAL_TYPES[query.approvalType] : undefined;
  const named =
    query.type === 'identity'
      ? [{ id: 'system_admin', name: '系统管理员', applicable: true }]
      : [
          { id: 'subject_employee', name: '主体员工本人', applicable: !type || allowsSubjectEmployee(type) },
          { id: 'rehire_direct_manager', name: '返聘后直线经理', applicable: type?.code === 'retirement' },
        ];
  const rows = named.filter((entry) => entry.applicable);
  if (!rows.length)
    return sql`SELECT NULL::text AS id,NULL::text AS name,true AS enabled,NULL::uuid AS parent_id WHERE false`;
  return sql.join(
    rows.map(
      (row) => sql`SELECT ${row.id}::text AS id,${row.name}::text AS name,true AS enabled,NULL::uuid AS parent_id`,
    ),
    sql` UNION ALL `,
  );
}
/**
 * F-326 §5.3：只给人员 / 多人变量；`enabled` 表示现在能被流程选用（启用，公共变量另须适用范围含“流程”），
 * 草稿 / 停用 / 移出范围的只在 ids 回查（includeInactive）时以 enabled=false 出现，供设计器标“已停用”。
 */
function variableRows(tenantId: string, query: ReturnType<typeof designerSourcesQuery>) {
  const scope =
    query.type === 'public_variable'
      ? sql`scope='public'`
      : sql`scope='application' AND app_id=${APPROVAL_TYPE_APPS[query.approvalType!]}`;
  return sql`SELECT id::text AS id,name||'（'||code||'）' AS name,
      (status='enabled' AND (scope='application' OR 'process'=ANY(usage_scopes))) AS enabled,
      NULL::uuid AS parent_id,(data_type='persons') AS multiple
    FROM approval_variables WHERE tenant_id=${tenantId}::uuid AND ${scope} AND data_type IN ('person','persons')`;
}
/** 矩阵头为一级（parentId=null），角色列为二级（id=`<矩阵>:<列>`，parentId=矩阵）；条件列不是审批人来源。 */
function matrixRows(tenantId: string) {
  return sql`SELECT m.id::text AS id,m.name,(m.status='enabled') AS enabled,
      NULL::uuid AS parent_id,NULL::boolean AS multiple
      FROM approval_matrices m WHERE m.tenant_id=${tenantId}::uuid
    UNION ALL
    SELECT m.id::text||':'||c.id::text,c.name,(m.status='enabled'),m.id,c.allow_multiple
      FROM approval_matrix_columns c JOIN approval_matrices m ON m.tenant_id=c.tenant_id AND m.id=c.matrix_id
      WHERE c.tenant_id=${tenantId}::uuid AND c.kind='role'`;
}
async function candidateRows(tx: Tx, tenantId: string, query: ReturnType<typeof designerSourcesQuery>) {
  if (query.type === 'public_variable' || query.type === 'application_variable') return variableRows(tenantId, query);
  if (query.type === 'matrix') return matrixRows(tenantId);
  if (query.type === 'object_field') return namedRows(query);
  // 身份没有组织维度与停用状态；登记的身份均可选，成员是否有效在运行时按实时授权判断。
  if (query.type === 'identity')
    return sql`SELECT id::text AS id,name,true AS enabled,NULL::uuid AS parent_id FROM permission_profiles
      WHERE tenant_id=${tenantId} UNION ALL ${namedRows(query)}`;
  const dimension = sourceDimension(query.type);
  if (!(await dimensionEnabled(tx, tenantId, dimension)))
    throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_DIMENSION_DISABLED', '审批来源的组织维度未启用');
  return dimension
    ? orgReferenceRows(tenantId, query.asOf, dimension)
    : jobReferenceRows(tenantId, query.asOf, query.type === 'position' ? 'position' : 'job');
}
const isMultipleSource = (type: string) =>
  type === 'matrix' || type === 'public_variable' || type === 'application_variable';
export async function listDesignerSources(tx: Tx, tenantId: string, query: ReturnType<typeof designerSourcesQuery>) {
  const rows = await candidateRows(tx, tenantId, query);
  // 数组字面量里的 `:` 不需转义；id 已按 UUID / UUID:UUID 校验，不含逗号与引号
  const filter = query.ids ? sql`AND c.id::text=ANY(${`{${query.ids.join(',')}}`}::text[])` : sql``;
  const multiple = isMultipleSource(query.type) ? sql`,c.multiple` : sql``;
  const pattern = `%${(query.keyword ?? '').replace(/[\\%_]/g, (v) => `\\${v}`)}%`;
  const size = query.ids ? query.ids.length : query.pageSize;
  const items = rowsOf<{
    id: string;
    name: string;
    enabled: boolean;
    parentId: string | null;
    multiple?: boolean | null;
  }>(
    await tx.execute(sql`SELECT c.id::text AS id,c.name,c.enabled,c.parent_id AS "parentId"${multiple} FROM (${rows}) c
      WHERE (${query.includeInactive} OR c.enabled) AND c.name ILIKE ${pattern} ESCAPE '\\' ${filter}
      ORDER BY c.name,c.id LIMIT ${size + 1} OFFSET ${query.ids ? 0 : (query.page - 1) * size}`),
  );
  return {
    items: items
      .slice(0, size)
      .map(({ multiple: many, ...item }) => (many == null ? item : { ...item, multiple: many })),
    page: query.ids ? 1 : query.page,
    pageSize: size,
    hasMore: items.length > size,
  };
}
