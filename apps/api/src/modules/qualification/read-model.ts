/**
 * 任职资格读模型：各对象的视图、列表（范围谓词在分页之前生效，DEC-317②）与详情。视图字段名与对象目录一致
 * （packages/domain/src/qualification/catalog.ts），响应再按字段权限裁剪。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { QualificationObject } from './access.js';
import { rowsOf, tableOf } from './store.js';

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

const INTERNAL = new Set(['tenant_id', 'editable', 'readable']);
const NUMERIC = new Set(['weight', 'score']);

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** 行 → 视图：列名转驼峰，去掉租户与访问判定列，numeric 转数字。 */
export function view<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !INTERNAL.has(key))
      .map(([key, value]) => [
        camel(key),
        NUMERIC.has(key) && value !== null && value !== undefined ? Number(value) : value,
      ]),
  ) as T;
}

export interface Tracked {
  readonly id: string;
  readonly revision: number;
}
export interface OwnedView extends Tracked {
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly publicDown?: boolean;
  readonly enabled?: boolean;
}
export interface JobLinked extends OwnedView {
  readonly jobLinkType: string | null;
  readonly jobLinks: { jobObjectId: string }[];
}
export interface GradeDetailView {
  readonly id: string;
  readonly name: string;
  readonly grade: number;
  readonly score: number | null;
  readonly description: string | null;
}
export interface GradeSchemeView extends Tracked {
  readonly name: string;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly details: GradeDetailView[];
}
export interface AbilityRow {
  readonly id: string;
  readonly content: string;
  readonly targetValue: string | null;
  readonly targetGradeId: string | null;
  readonly weight: number | null;
  readonly source: 'manual' | 'copied' | 'common_overwrite';
  readonly sourceTargetId: string | null;
}
export interface DetailRow {
  readonly id: string;
  readonly levelId: string;
  readonly targetId: string;
  readonly targetValue: string | null;
  readonly weight: number | null;
  /** 通用指标的格不可编辑（DEC-334①）。 */
  readonly locked: boolean;
  readonly abilities: AbilityRow[];
}
export interface StandardView extends Tracked {
  readonly categoryId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly levelIds: string[];
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly details: DetailRow[];
  readonly levelDescriptions: { levelId: string; description: string }[];
}

const ORDER: Readonly<Partial<Record<QualificationObject, SQL>>> = {
  categoryClass: sql`t.level, t.display_order, t.code`,
  category: sql`t.code`,
  layer: sql`t.display_order, t.name`,
  level: sql`t.display_order`,
  targetType: sql`t.display_order, t.code`,
  target: sql`t.display_order, t.code`,
  gradeScheme: sql`t.name`,
  standard: sql`t.created_at, t.id`,
};

/** 列表：`readable` 是作用在别名 t 上的范围谓词（分页之前生效）。 */
export async function listRows(
  tx: Tx,
  tenantId: string,
  object: QualificationObject,
  readable: SQL,
  page: Page,
  filter: SQL = sql`true`,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`SELECT t.* FROM ${sql.identifier(tableOf(object))} t
    WHERE t.tenant_id = ${tenantId}::uuid AND ${readable} AND ${filter}
    ORDER BY ${ORDER[object] ?? sql`t.id`}, t.id LIMIT ${page.limit} OFFSET ${page.offset}`);
  return rowsOf(result);
}

export async function loadRow(tx: Tx, tenantId: string, object: QualificationObject, id: string) {
  const result = await tx.execute(sql`SELECT t.* FROM ${sql.identifier(tableOf(object))} t
    WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${id}::uuid`);
  return rowsOf<Record<string, unknown>>(result)[0];
}

const LINK_TABLES = {
  category: ['ql_category_job_links', 'category_id'],
  level: ['ql_level_job_links', 'level_id'],
} as const;

/** 类别 / 级别带上岗职务关联（按关联建立顺序）。 */
export async function withJobLinks<T extends Record<string, unknown>>(
  tx: Tx,
  tenantId: string,
  object: 'category' | 'level',
  rows: T[],
): Promise<JobLinked[]> {
  if (!rows.length) return [];
  const [table, key] = LINK_TABLES[object];
  const ids = rows.map((row) => row.id as string);
  const links = rowsOf<{ owner: string; job_object_id: string }>(
    await tx.execute(sql`SELECT ${sql.identifier(key)} AS owner, job_object_id FROM ${sql.identifier(table)}
      WHERE tenant_id = ${tenantId}::uuid AND ${sql.identifier(key)} = ANY(${`{${ids.join(',')}}`}::uuid[])
      ORDER BY ctid`),
  );
  return rows.map((row) => ({
    ...view<JobLinked>(row),
    jobLinks: links.filter((link) => link.owner === row.id).map((link) => ({ jobObjectId: link.job_object_id })),
  }));
}

export async function gradeDetails(tx: Tx, tenantId: string, schemeId: string): Promise<GradeDetailView[]> {
  const result = await tx.execute(sql`SELECT id, name, grade, score, description FROM ql_grade_details
    WHERE tenant_id = ${tenantId}::uuid AND scheme_id = ${schemeId}::uuid AND deleted_at IS NULL
    ORDER BY grade, ctid`);
  return rowsOf<Record<string, unknown>>(result).map((row) => view<GradeDetailView>(row));
}

export async function withGradeDetails(tx: Tx, tenantId: string, rows: Record<string, unknown>[]) {
  const views: GradeSchemeView[] = [];
  for (const row of rows) {
    views.push({ ...view<GradeSchemeView>(row), details: await gradeDetails(tx, tenantId, row.id as string) });
  }
  return views;
}

/** 标准：级别 × 指标网格、每格能力标准（按顺序）、级别描述；通用指标的格标记为锁定。 */
export async function withStandardParts(tx: Tx, tenantId: string, rows: Record<string, unknown>[]) {
  const views: StandardView[] = [];
  for (const row of rows) {
    const id = row.id as string;
    const details = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT d.id, d.level_id, d.target_id, d.target_value, d.weight, t.is_common AS locked
        FROM ql_standard_details d JOIN ql_targets t ON t.tenant_id = d.tenant_id AND t.id = d.target_id
        JOIN ql_levels l ON l.tenant_id = d.tenant_id AND l.id = d.level_id
        WHERE d.tenant_id = ${tenantId}::uuid AND d.standard_id = ${id}::uuid
        ORDER BY l.display_order, t.display_order, t.code`),
    );
    const abilities = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT a.id, a.detail_id, a.content, a.target_value, a.target_grade_id, a.weight, a.source,
          a.source_target_id
        FROM ql_ability_details a JOIN ql_standard_details d ON d.tenant_id = a.tenant_id AND d.id = a.detail_id
        WHERE a.tenant_id = ${tenantId}::uuid AND d.standard_id = ${id}::uuid ORDER BY a.display_order, a.ctid`),
    );
    const descriptions = rowsOf<{ level_id: string; description: string }>(
      await tx.execute(sql`SELECT level_id, description FROM ql_level_descriptions
        WHERE tenant_id = ${tenantId}::uuid AND standard_id = ${id}::uuid`),
    );
    views.push({
      ...view<StandardView>(row),
      details: details.map((detail) => ({
        ...view<Omit<DetailRow, 'abilities'>>(detail),
        abilities: abilities
          .filter((ability) => ability.detail_id === detail.id)
          .map(({ detail_id: _detail, ...ability }) => view<AbilityRow>(ability)),
      })),
      levelDescriptions: descriptions.map((d) => ({ levelId: d.level_id, description: d.description })),
    });
  }
  return views;
}
