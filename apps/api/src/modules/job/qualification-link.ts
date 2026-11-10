/**
 * 「关联任职资格」只读投影（Q-M0-17、docs/02_业务建模/19）：由任职资格侧的任职类别关联岗职务后带出，职务上不可手选，
 * 所以只在读取出口按 ql_category_job_links 补 qualificationId（类别 ID）；写入路径读到的仍是存储列（恒为空）。
 * 一个岗职务在同一类型下最多关联一个类别（唯一约束），不需要排序取舍。
 */
import { sql, type QualificationCategoryLink, type Tx } from '@italent/db';
import type { JobKind } from './metadata.js';
import { rowsOf } from './store.js';

const LINK_TYPES: Partial<Record<JobKind, QualificationCategoryLink>> = {
  posts: 'post',
  positions: 'position',
  sequences: 'sequence',
  'level-types': 'level_type',
};

export async function withLinkedQualification<T extends { readonly id: string }>(
  tx: Tx,
  tenantId: string,
  kind: JobKind,
  items: readonly T[],
): Promise<(T & { qualificationId: string | null })[]> {
  const type = LINK_TYPES[kind];
  const ids = items.map((item) => item.id);
  const links = new Map<string, string>();
  if (type && ids.length > 0) {
    const rows = rowsOf<{ objectId: string; categoryId: string }>(
      await tx.execute(sql`SELECT job_object_id AS "objectId", category_id AS "categoryId" FROM ql_category_job_links
        WHERE tenant_id = ${tenantId} AND job_link_type = ${type}
          AND job_object_id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`),
    );
    for (const row of rows) links.set(row.objectId, row.categoryId);
  }
  return items.map((item) => ({ ...item, qualificationId: links.get(item.id) ?? null }));
}
