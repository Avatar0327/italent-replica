/**
 * 任职记录 → 任职类别 / 任职级别的唯一映射（设计 §4.2，QL-R15 🟢 G-047，DEC-331④，DEC-335②）。
 * - 类别：按 职位 > 职务 > 职务序列 > 职级类别 依次查关联，第一个**恰好命中 1 个启用类别**的类型胜出；同一类型下一个岗职务
 *   只关联一个类别（ql_category_job_links 唯一），所以同类型不会多命中。“职务”排在职位之后、序列之前是按手册与设计推荐（DEC-335② 🟡）。
 *   职级类别 = 记录职级（levelId）在判定日的职级版本上的 level_type_id。
 * - 级别：记录的职级、职等各自关联的启用级别并集，须恰好 1 个；两个不同级别 → AMBIGUOUS_MAPPING（不猜），没有 → NO_MAPPING。
 *   “职级 → 职等”的先后在原站无实测（🟡）：并集要求唯一，比任选一个优先更保守。
 * 只读，不带数据范围：只给后台同步判断“写哪一类 / 哪一级”，调用方不得把结果原样透出。
 */
import { sql, type Tx } from '@italent/db';
import type { QualificationCategoryLink } from '@italent/db';
import { rowsOf } from '../employment/record-store.js';
import type { PresetFields } from '../employment/types.js';

export type MappingFields = Pick<PresetFields, 'positionId' | 'postId' | 'sequenceId' | 'levelId' | 'gradeId'>;

export type MappingResult =
  | { readonly kind: 'mapped'; readonly categoryId: string; readonly levelId: string }
  | { readonly kind: 'skipped'; readonly reason: 'NO_MAPPING' | 'AMBIGUOUS_MAPPING' };

/** 类别关联类型的优先级（QL-R15、DEC-335②）。 */
const CATEGORY_PRIORITY: readonly QualificationCategoryLink[] = ['position', 'post', 'sequence', 'level_type'];

async function levelTypeOf(tx: Tx, tenantId: string, levelId: string, asOf: string): Promise<string | null> {
  const [row] = rowsOf<{ typeId: string | null }>(
    await tx.execute(sql`SELECT level_type_id AS "typeId" FROM job_level_versions
      WHERE tenant_id=${tenantId} AND object_id=${levelId}::uuid AND start_date <= ${asOf}::date
      ORDER BY start_date DESC, version_no DESC LIMIT 1`),
  );
  return row?.typeId ?? null;
}

async function enabledCategoryFor(
  tx: Tx,
  tenantId: string,
  type: QualificationCategoryLink,
  jobObjectId: string,
): Promise<string[]> {
  return rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT c.id FROM ql_category_job_links l
      JOIN ql_categories c ON c.tenant_id=l.tenant_id AND c.id=l.category_id
      WHERE l.tenant_id=${tenantId} AND l.job_link_type=${type} AND c.enabled
        AND l.job_object_id=${jobObjectId}::uuid`),
  ).map((row) => row.id);
}

async function mappedCategory(tx: Tx, tenantId: string, fields: MappingFields, asOf: string): Promise<string | null> {
  const objectOf: Record<QualificationCategoryLink, () => Promise<string | null>> = {
    position: async () => fields.positionId,
    post: async () => fields.postId,
    sequence: async () => fields.sequenceId,
    level_type: async () => (fields.levelId ? levelTypeOf(tx, tenantId, fields.levelId, asOf) : null),
  };
  for (const type of CATEGORY_PRIORITY) {
    const jobObjectId = await objectOf[type]();
    if (!jobObjectId) continue;
    const hits = await enabledCategoryFor(tx, tenantId, type, jobObjectId);
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

async function mappedLevels(tx: Tx, tenantId: string, fields: MappingFields): Promise<string[]> {
  const links = [
    ['level', fields.levelId],
    ['grade', fields.gradeId],
  ] as const;
  const found = new Set<string>();
  for (const [type, jobObjectId] of links) {
    if (!jobObjectId) continue;
    const rows = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT v.id FROM ql_level_job_links l
        JOIN ql_levels v ON v.tenant_id=l.tenant_id AND v.id=l.level_id
        WHERE l.tenant_id=${tenantId} AND l.job_link_type=${type} AND v.enabled
          AND l.job_object_id=${jobObjectId}::uuid`),
    );
    for (const row of rows) found.add(row.id);
  }
  return [...found];
}

export async function mapEmploymentToQualification(
  tx: Tx,
  tenantId: string,
  fields: MappingFields,
  asOf: string,
): Promise<MappingResult> {
  const categoryId = await mappedCategory(tx, tenantId, fields, asOf);
  if (!categoryId) return { kind: 'skipped', reason: 'NO_MAPPING' };
  const levels = await mappedLevels(tx, tenantId, fields);
  if (levels.length === 0) return { kind: 'skipped', reason: 'NO_MAPPING' };
  if (levels.length > 1) return { kind: 'skipped', reason: 'AMBIGUOUS_MAPPING' };
  return { kind: 'mapped', categoryId, levelId: levels[0]! };
}
