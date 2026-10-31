/** DEC-691：流程编辑者的引用候选，只返回 ID / 名称 / 状态 / 父级；不暴露人员与授权成员。 */
import { sql, type Tx } from '@italent/db';
import { RELATION_SOURCE_TYPES } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { validIsoDate } from '../org/read-model.js';
import { approvalError, canonicalId, rowsOf } from './context.js';
import { dimensionEnabled, sourceDimension, orgReferenceRows, jobReferenceRows } from './source-reference.js';

const querySchema = z.object({
  type: z.enum(RELATION_SOURCE_TYPES),
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
    .pipe(z.array(z.uuid().transform(canonicalId)).min(1).max(100))
    .optional(),
});
export function designerSourcesQuery(query: Record<string, string>) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '审批来源候选查询参数不合法');
  return parsed.data;
}
export async function listDesignerSources(tx: Tx, tenantId: string, query: ReturnType<typeof designerSourcesQuery>) {
  const dimension = sourceDimension(query.type);
  if (!(await dimensionEnabled(tx, tenantId, dimension)))
    throw approvalError('APPROVAL_SOURCE_INVALID', 'APPROVAL_SOURCE_DIMENSION_DISABLED', '审批来源的组织维度未启用');
  const rows = dimension
    ? orgReferenceRows(tenantId, query.asOf, dimension)
    : jobReferenceRows(tenantId, query.asOf, query.type === 'position' ? 'position' : 'job');
  const filter = query.ids ? sql`AND c.id=ANY(${`{${query.ids.join(',')}}`}::uuid[])` : sql``;
  const pattern = `%${(query.keyword ?? '').replace(/[\\%_]/g, (v) => `\\${v}`)}%`;
  const size = query.ids ? query.ids.length : query.pageSize;
  const items = rowsOf<{ id: string; name: string; enabled: boolean; parentId: string | null }>(
    await tx.execute(sql`SELECT c.id,c.name,c.enabled,c.parent_id AS "parentId" FROM (${rows}) c
      WHERE (${query.includeInactive} OR c.enabled) AND c.name ILIKE ${pattern} ESCAPE '\\' ${filter}
      ORDER BY c.name,c.id LIMIT ${size + 1} OFFSET ${query.ids ? 0 : (query.page - 1) * size}`),
  );
  return {
    items: items.slice(0, size),
    page: query.ids ? 1 : query.page,
    pageSize: size,
    hasMore: items.length > size,
  };
}
