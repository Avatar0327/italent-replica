/**
 * 人才标准的读取（docs/02_业务建模/23 §2.1、§7）。人才标准里的指标只存引用，读取时取指标库**当前**内容（TC-R2）；
 * 指标的类型取自所属指标库，分类名称、发展建议类型名称是查找字段的显示值。列表的范围谓词在 SQL 里、分页之前生效。
 * 指标库启用状态只给可信端口（DimensionRecord），HTTP 视图与审计快照不投影（DEC-281⑪）。
 */
import {
  and,
  asc,
  eq,
  inArray,
  sql,
  talentCriteria,
  talentCriterionCategories,
  talentCriterionDimensions,
  talentDescriptionTypes,
  talentDimensionBehaviors,
  talentDimensionCategories,
  talentDimensionGrades,
  talentDimensionLibraries,
  talentDimensionQuestions,
  talentDimensions,
  talentDimensionSuggestions,
  type Tx,
} from '@italent/db';
import type { TalentDimensionType } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export interface Tracked {
  readonly id: string;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** DEC-281⑨：所属人与所属管理单元（组织）。 */
export interface Owned extends Tracked {
  readonly ownerId: string;
  readonly ownerOrgId: string;
}

export interface LibraryView extends Owned {
  readonly name: string;
  readonly type: TalentDimensionType;
  readonly enabled: boolean;
  readonly displayOrder: number;
}

export interface DimensionCategoryView extends Owned {
  readonly libraryId: string;
  readonly name: string;
  readonly displayOrder: number;
}

export interface DescriptionTypeView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GradeView {
  readonly gradeOrder: number;
  readonly alias: string | null;
  readonly description: string | null;
}
export interface BehaviorView {
  readonly description: string;
  readonly keyPoints: string | null;
  readonly displayOrder: number;
}
export interface SuggestionView {
  /** 建议行身份（第 5 轮清单 1）：编辑时带回表示保留这一行。 */
  readonly id: string;
  readonly typeId: string;
  readonly typeName: string;
  readonly description: string;
  readonly displayOrder: number;
}
export interface QuestionView {
  readonly question: string;
  readonly keyPoints: string | null;
  readonly displayOrder: number;
}

export interface DimensionView extends Owned {
  readonly libraryId: string;
  readonly type: TalentDimensionType;
  readonly code: string;
  readonly name: string;
  readonly definition: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly grades: GradeView[];
  readonly behaviors: BehaviorView[];
  readonly suggestions: SuggestionView[];
  readonly questions: QuestionView[];
}

/** 可信端口用：另带指标库启用状态（调用方据此判断能否新引用，TC-R4）。 */
export interface DimensionRecord extends DimensionView {
  readonly libraryEnabled: boolean;
}

export interface CategoryView extends Owned {
  readonly name: string;
  readonly displayOrder: number;
}

export interface CriterionDimensionView {
  readonly dimensionId: string;
  readonly type: TalentDimensionType;
  readonly weight: number | null;
  readonly target: number | null;
  readonly displayOrder: number;
  /** DEC-294⑤：关联记录自己的“指标类别”文本。 */
  readonly dimensionCategory: string | null;
  /** DEC-294③：关联记录的所属人 / 所属管理单元（系统填写）。 */
  readonly ownerId: string;
  readonly ownerOrgId: string;
  readonly dimension: DimensionRecord;
}

export interface CriterionView extends Owned {
  readonly categoryId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly abilityNote: string | null;
  readonly potentialNote: string | null;
  readonly experienceNote: string | null;
  readonly achievementNote: string | null;
  readonly dimensions: CriterionDimensionView[];
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

const L = talentDimensionLibraries;
const K = talentDimensionCategories;
const T = talentDescriptionTypes;
const D = talentDimensions;
const N = talentCriterionCategories;
const C = talentCriteria;

const owned = (table: typeof L | typeof K | typeof N | typeof C) => ({
  id: table.id,
  revision: table.revision,
  ownerId: table.ownerId,
  ownerOrgId: table.ownerOrgId,
  createdBy: table.createdBy,
  createdAt: table.createdAt,
  updatedAt: table.updatedAt,
});

// ---- 指标库 ----

const libraryColumns = {
  ...owned(L),
  name: L.name,
  type: L.type,
  enabled: L.enabled,
  displayOrder: L.displayOrder,
};

export async function listLibraries(
  tx: Tx,
  tenantId: string,
  query: Page & { type?: TalentDimensionType; enabled?: boolean; visible: SQL },
): Promise<LibraryView[]> {
  return tx
    .select(libraryColumns)
    .from(L)
    .where(
      and(
        eq(L.tenantId, tenantId),
        query.type ? eq(L.type, query.type) : undefined,
        query.enabled === undefined ? undefined : eq(L.enabled, query.enabled),
        query.visible,
      ),
    )
    .orderBy(asc(L.displayOrder), asc(L.createdAt), asc(L.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function loadLibrary(tx: Tx, tenantId: string, id: string): Promise<LibraryView | undefined> {
  const [row] = await tx
    .select(libraryColumns)
    .from(L)
    .where(and(eq(L.tenantId, tenantId), eq(L.id, id)));
  return row;
}

// ---- 指标库内分类 ----

const dimensionCategoryColumns = { ...owned(K), libraryId: K.libraryId, name: K.name, displayOrder: K.displayOrder };

export async function listDimensionCategories(
  tx: Tx,
  tenantId: string,
  query: Page & { libraryId?: string; visible: SQL },
): Promise<DimensionCategoryView[]> {
  return tx
    .select(dimensionCategoryColumns)
    .from(K)
    .where(and(eq(K.tenantId, tenantId), query.libraryId ? eq(K.libraryId, query.libraryId) : undefined, query.visible))
    .orderBy(asc(K.displayOrder), asc(K.createdAt), asc(K.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function loadDimensionCategory(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<DimensionCategoryView | undefined> {
  const [row] = await tx
    .select(dimensionCategoryColumns)
    .from(K)
    .where(and(eq(K.tenantId, tenantId), eq(K.id, id)));
  return row;
}

// ---- 发展建议类型 ----

const descriptionTypeColumns = {
  id: T.id,
  revision: T.revision,
  name: T.name,
  enabled: T.enabled,
  displayOrder: T.displayOrder,
  createdBy: T.createdBy,
  createdAt: T.createdAt,
  updatedAt: T.updatedAt,
};

export async function listDescriptionTypes(
  tx: Tx,
  tenantId: string,
  query: Page & { enabled?: boolean; visible: SQL },
): Promise<DescriptionTypeView[]> {
  return tx
    .select(descriptionTypeColumns)
    .from(T)
    .where(
      and(
        eq(T.tenantId, tenantId),
        query.enabled === undefined ? undefined : eq(T.enabled, query.enabled),
        query.visible,
      ),
    )
    .orderBy(asc(T.displayOrder), asc(T.name), asc(T.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function loadDescriptionType(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<DescriptionTypeView | undefined> {
  const [row] = await tx
    .select(descriptionTypeColumns)
    .from(T)
    .where(and(eq(T.tenantId, tenantId), eq(T.id, id)));
  return row;
}

// ---- 指标 ----

// 联表查询里列的可空性按所属表推断，这里逐列写出指标表的列
const dimensionColumns = {
  id: D.id,
  revision: D.revision,
  ownerId: D.ownerId,
  ownerOrgId: D.ownerOrgId,
  createdBy: D.createdBy,
  createdAt: D.createdAt,
  updatedAt: D.updatedAt,
  libraryId: D.libraryId,
  type: L.type,
  libraryEnabled: L.enabled,
  code: D.code,
  name: D.name,
  definition: D.definition,
  categoryId: D.categoryId,
  categoryName: K.name,
  displayOrder: D.displayOrder,
  enabled: D.enabled,
};

export interface DimensionQuery extends Page {
  readonly libraryId?: string;
  readonly categoryId?: string;
  readonly type?: TalentDimensionType;
  readonly enabled?: boolean;
  /** 只列可被新引用的指标：指标与指标库都已启用（TC-R4）。 */
  readonly referenceable?: boolean;
  readonly name?: string;
  readonly visible: SQL;
}

function dimensionsFrom(tx: Tx) {
  return tx
    .select(dimensionColumns)
    .from(D)
    .innerJoin(L, and(eq(L.tenantId, D.tenantId), eq(L.id, D.libraryId)))
    .leftJoin(K, and(eq(K.tenantId, D.tenantId), eq(K.id, D.categoryId)));
}

export async function listDimensionRecords(
  tx: Tx,
  tenantId: string,
  query: DimensionQuery,
): Promise<DimensionRecord[]> {
  const rows = await dimensionsFrom(tx)
    .where(
      and(
        eq(D.tenantId, tenantId),
        query.libraryId ? eq(D.libraryId, query.libraryId) : undefined,
        query.categoryId ? eq(D.categoryId, query.categoryId) : undefined,
        query.type ? eq(L.type, query.type) : undefined,
        query.enabled === undefined ? undefined : eq(D.enabled, query.enabled),
        query.referenceable ? and(eq(D.enabled, true), eq(L.enabled, true)) : undefined,
        query.name ? nameLike(D.name, query.name) : undefined,
        query.visible,
      ),
    )
    .orderBy(asc(L.displayOrder), asc(D.displayOrder), asc(D.code), asc(D.id))
    .limit(query.limit)
    .offset(query.offset);
  return withDetails(tx, tenantId, rows);
}

export async function listDimensions(tx: Tx, tenantId: string, query: DimensionQuery): Promise<DimensionView[]> {
  return (await listDimensionRecords(tx, tenantId, query)).map(dimensionView);
}

export async function loadDimensionRecords(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<DimensionRecord[]> {
  if (!ids.length) return [];
  const rows = await dimensionsFrom(tx)
    .where(and(eq(D.tenantId, tenantId), inArray(D.id, [...ids])))
    .orderBy(asc(D.id));
  return withDetails(tx, tenantId, rows);
}

export async function loadDimension(tx: Tx, tenantId: string, id: string): Promise<DimensionView | undefined> {
  const [record] = await loadDimensionRecords(tx, tenantId, [id]);
  return record && dimensionView(record);
}

/** HTTP 视图与审计快照：去掉指标库启用状态（DEC-281⑪ / Q5 投影一并去掉）。 */
export function dimensionView({ libraryEnabled: _state, ...view }: DimensionRecord): DimensionView {
  return view;
}

type DimensionRow = Omit<DimensionRecord, 'grades' | 'behaviors' | 'suggestions' | 'questions'>;

async function withDetails(tx: Tx, tenantId: string, rows: DimensionRow[]): Promise<DimensionRecord[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const of = <R extends { dimensionId: string }>(items: R[], id: string) =>
    items.filter((item) => item.dimensionId === id).map(({ dimensionId: _id, ...rest }) => rest);
  const scoped = (table: { tenantId: AnyPgColumn; dimensionId: AnyPgColumn }) =>
    and(eq(table.tenantId, tenantId), inArray(table.dimensionId, ids));
  const G = talentDimensionGrades;
  const B = talentDimensionBehaviors;
  const S = talentDimensionSuggestions;
  const Q = talentDimensionQuestions;
  const grades = await tx
    .select({ dimensionId: G.dimensionId, gradeOrder: G.gradeOrder, alias: G.alias, description: G.description })
    .from(G)
    .where(scoped(G))
    .orderBy(asc(G.gradeOrder));
  const behaviors = await tx
    .select({
      dimensionId: B.dimensionId,
      description: B.description,
      keyPoints: B.keyPoints,
      displayOrder: B.displayOrder,
    })
    .from(B)
    .where(scoped(B))
    .orderBy(asc(B.displayOrder), asc(B.id));
  const suggestions = await tx
    .select({
      id: S.id,
      dimensionId: S.dimensionId,
      typeId: S.typeId,
      typeName: T.name,
      description: S.description,
      displayOrder: S.displayOrder,
    })
    .from(S)
    .innerJoin(T, and(eq(T.tenantId, S.tenantId), eq(T.id, S.typeId)))
    .where(scoped(S))
    .orderBy(asc(S.displayOrder), asc(S.id));
  const questions = await tx
    .select({ dimensionId: Q.dimensionId, question: Q.question, keyPoints: Q.keyPoints, displayOrder: Q.displayOrder })
    .from(Q)
    .where(scoped(Q))
    .orderBy(asc(Q.displayOrder), asc(Q.id));
  return rows.map((row) => ({
    ...row,
    grades: of(grades, row.id),
    behaviors: of(behaviors, row.id),
    suggestions: of(suggestions, row.id),
    questions: of(questions, row.id),
  }));
}

// ---- 人才标准分类 ----

const categoryColumns = { ...owned(N), name: N.name, displayOrder: N.displayOrder };

export async function listCategories(tx: Tx, tenantId: string, query: Page & { visible: SQL }) {
  return tx
    .select(categoryColumns)
    .from(N)
    .where(and(eq(N.tenantId, tenantId), query.visible))
    .orderBy(asc(N.displayOrder), asc(N.createdAt), asc(N.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function loadCategory(tx: Tx, tenantId: string, id: string): Promise<CategoryView | undefined> {
  const [row] = await tx
    .select(categoryColumns)
    .from(N)
    .where(and(eq(N.tenantId, tenantId), eq(N.id, id)));
  return row;
}

// ---- 人才标准 ----

const criterionColumns = {
  ...owned(C),
  categoryId: C.categoryId,
  name: C.name,
  enabled: C.enabled,
  abilityNote: C.abilityNote,
  potentialNote: C.potentialNote,
  experienceNote: C.experienceNote,
  achievementNote: C.achievementNote,
};

export async function listCriteria(
  tx: Tx,
  tenantId: string,
  query: Page & { categoryId?: string; enabled?: boolean; name?: string; visible: SQL },
): Promise<CriterionView[]> {
  const rows = await tx
    .select(criterionColumns)
    .from(C)
    .where(
      and(
        eq(C.tenantId, tenantId),
        query.categoryId ? eq(C.categoryId, query.categoryId) : undefined,
        query.enabled === undefined ? undefined : eq(C.enabled, query.enabled),
        query.name ? nameLike(C.name, query.name) : undefined,
        query.visible,
      ),
    )
    .orderBy(asc(C.createdAt), asc(C.id))
    .limit(query.limit)
    .offset(query.offset);
  return withReferences(tx, tenantId, rows);
}

export async function loadCriterion(tx: Tx, tenantId: string, id: string): Promise<CriterionView | undefined> {
  const rows = await tx
    .select(criterionColumns)
    .from(C)
    .where(and(eq(C.tenantId, tenantId), eq(C.id, id)));
  return (await withReferences(tx, tenantId, rows))[0];
}

type CriterionRow = Omit<CriterionView, 'dimensions'>;

/** 标准引用的指标：关系行 + 指标当前内容（TC-R2，不读任何快照）。 */
async function withReferences(tx: Tx, tenantId: string, rows: CriterionRow[]): Promise<CriterionView[]> {
  if (!rows.length) return [];
  const R = talentCriterionDimensions;
  const relations = await tx
    .select({
      criterionId: R.criterionId,
      dimensionId: R.dimensionId,
      weight: R.weight,
      target: R.target,
      displayOrder: R.displayOrder,
      dimensionCategory: R.dimensionCategory,
      ownerId: R.ownerId,
      ownerOrgId: R.ownerOrgId,
    })
    .from(R)
    .where(
      and(
        eq(R.tenantId, tenantId),
        inArray(
          R.criterionId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(R.displayOrder), asc(R.id));
  const ids = [...new Set(relations.map((relation) => relation.dimensionId))];
  const dimensions = new Map((await loadDimensionRecords(tx, tenantId, ids)).map((d) => [d.id, d]));
  return rows.map((row) => ({
    ...row,
    dimensions: relations
      .filter((relation) => relation.criterionId === row.id)
      .map((relation) => {
        const dimension = dimensions.get(relation.dimensionId)!;
        return {
          dimensionId: relation.dimensionId,
          type: dimension.type,
          weight: relation.weight === null ? null : Number(relation.weight),
          target: relation.target === null ? null : Number(relation.target),
          displayOrder: relation.displayOrder,
          dimensionCategory: relation.dimensionCategory,
          ownerId: relation.ownerId,
          ownerOrgId: relation.ownerOrgId,
          dimension,
        };
      }),
  }));
}

/**
 * 删除前的“是否还在使用”计数（TC-R5 同口径）：表与列都是本模块的固定名称，调用方已持被引用行的行锁。
 * 例：引用某指标的标准关系数、库下的指标 / 分类数、引用某分类的指标数、引用某类型的发展建议数。
 */
export async function usageCount(tx: Tx, table: string, column: string, tenantId: string, id: string) {
  const result = await tx.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)}
    WHERE tenant_id = ${tenantId} AND ${sql.identifier(column)} = ${id}::uuid`);
  const rows = (Array.isArray(result) ? result : (result as { rows: { count: number }[] }).rows) as {
    count: number;
  }[];
  return rows[0]?.count ?? 0;
}

/** 名称模糊查询：转义通配符，按字面匹配。 */
function nameLike(column: AnyPgColumn | SQL, value: string): SQL {
  return sql`${column} ILIKE ${`%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}`;
}
