/**
 * 人才标准的读取（docs/02_业务建模/23 §2.1）。人才标准里的指标只存引用，读取时取指标库**当前**内容（TC-R2）；
 * 指标的类型、指标库启用状态取自所属指标库。列表的范围谓词在 SQL 里、分页之前生效。
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
  talentDimensionBehaviors,
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

export interface LibraryView extends Tracked {
  readonly name: string;
  readonly type: TalentDimensionType;
  readonly enabled: boolean;
  readonly displayOrder: number;
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
  readonly suggestionType: string | null;
  readonly description: string;
  readonly displayOrder: number;
}
export interface QuestionView {
  readonly question: string;
  readonly keyPoints: string | null;
  readonly displayOrder: number;
}

export interface DimensionView extends Tracked {
  readonly libraryId: string;
  readonly libraryName: string;
  readonly type: TalentDimensionType;
  readonly libraryEnabled: boolean;
  readonly code: string;
  readonly name: string;
  readonly definition: string | null;
  readonly category: string | null;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly grades: GradeView[];
  readonly behaviors: BehaviorView[];
  readonly suggestions: SuggestionView[];
  readonly questions: QuestionView[];
}

export interface CategoryView extends Tracked {
  readonly name: string;
  readonly displayOrder: number;
}

export interface CriterionDimensionView {
  readonly dimensionId: string;
  readonly type: TalentDimensionType;
  readonly weight: number | null;
  readonly target: number | null;
  readonly displayOrder: number;
  readonly dimension: DimensionView;
}

export interface CriterionView extends Tracked {
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
const D = talentDimensions;
const C = talentCriteria;

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

const libraryColumns = {
  id: L.id,
  revision: L.revision,
  name: L.name,
  type: L.type,
  enabled: L.enabled,
  displayOrder: L.displayOrder,
  createdBy: L.createdBy,
  createdAt: L.createdAt,
  updatedAt: L.updatedAt,
};

export async function loadLibrary(tx: Tx, tenantId: string, id: string): Promise<LibraryView | undefined> {
  const [row] = await tx
    .select(libraryColumns)
    .from(L)
    .where(and(eq(L.tenantId, tenantId), eq(L.id, id)));
  return row;
}

const dimensionColumns = {
  id: D.id,
  revision: D.revision,
  libraryId: D.libraryId,
  libraryName: L.name,
  type: L.type,
  libraryEnabled: L.enabled,
  code: D.code,
  name: D.name,
  definition: D.definition,
  category: D.category,
  displayOrder: D.displayOrder,
  enabled: D.enabled,
  createdBy: D.createdBy,
  createdAt: D.createdAt,
  updatedAt: D.updatedAt,
};

export interface DimensionQuery extends Page {
  readonly libraryId?: string;
  readonly type?: TalentDimensionType;
  readonly enabled?: boolean;
  /** 只列可被新引用的指标：指标与指标库都已启用（TC-R4）。 */
  readonly referenceable?: boolean;
  readonly name?: string;
  readonly visible: SQL;
}

export async function listDimensions(tx: Tx, tenantId: string, query: DimensionQuery): Promise<DimensionView[]> {
  const rows = await tx
    .select(dimensionColumns)
    .from(D)
    .innerJoin(L, and(eq(L.tenantId, D.tenantId), eq(L.id, D.libraryId)))
    .where(
      and(
        eq(D.tenantId, tenantId),
        query.libraryId ? eq(D.libraryId, query.libraryId) : undefined,
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

export async function loadDimensions(tx: Tx, tenantId: string, ids: readonly string[]): Promise<DimensionView[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select(dimensionColumns)
    .from(D)
    .innerJoin(L, and(eq(L.tenantId, D.tenantId), eq(L.id, D.libraryId)))
    .where(and(eq(D.tenantId, tenantId), inArray(D.id, [...ids])))
    .orderBy(asc(D.id));
  return withDetails(tx, tenantId, rows);
}

export async function loadDimension(tx: Tx, tenantId: string, id: string): Promise<DimensionView | undefined> {
  return (await loadDimensions(tx, tenantId, [id]))[0];
}

type DimensionRow = Omit<DimensionView, 'grades' | 'behaviors' | 'suggestions' | 'questions'>;

async function withDetails(tx: Tx, tenantId: string, rows: DimensionRow[]): Promise<DimensionView[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const of = <T extends { dimensionId: string }>(items: T[], id: string) =>
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
      dimensionId: S.dimensionId,
      suggestionType: S.suggestionType,
      description: S.description,
      displayOrder: S.displayOrder,
    })
    .from(S)
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

const categoryColumns = {
  id: talentCriterionCategories.id,
  revision: talentCriterionCategories.revision,
  name: talentCriterionCategories.name,
  displayOrder: talentCriterionCategories.displayOrder,
  createdBy: talentCriterionCategories.createdBy,
  createdAt: talentCriterionCategories.createdAt,
  updatedAt: talentCriterionCategories.updatedAt,
};

export async function listCategories(tx: Tx, tenantId: string, query: Page & { visible: SQL }) {
  const K = talentCriterionCategories;
  return tx
    .select(categoryColumns)
    .from(K)
    .where(and(eq(K.tenantId, tenantId), query.visible))
    .orderBy(asc(K.displayOrder), asc(K.createdAt), asc(K.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function loadCategory(tx: Tx, tenantId: string, id: string): Promise<CategoryView | undefined> {
  const K = talentCriterionCategories;
  const [row] = await tx
    .select(categoryColumns)
    .from(K)
    .where(and(eq(K.tenantId, tenantId), eq(K.id, id)));
  return row;
}

const criterionColumns = {
  id: C.id,
  revision: C.revision,
  categoryId: C.categoryId,
  name: C.name,
  enabled: C.enabled,
  abilityNote: C.abilityNote,
  potentialNote: C.potentialNote,
  experienceNote: C.experienceNote,
  achievementNote: C.achievementNote,
  createdBy: C.createdBy,
  createdAt: C.createdAt,
  updatedAt: C.updatedAt,
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
  const dimensions = new Map(
    (await loadDimensions(tx, tenantId, [...new Set(relations.map((r) => r.dimensionId))])).map((d) => [d.id, d]),
  );
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
          dimension,
        };
      }),
  }));
}

/** 引用某指标的人才标准数（删除前判断，TC-R5）。 */
export async function dimensionReferenceCount(tx: Tx, tenantId: string, dimensionId: string): Promise<number> {
  const R = talentCriterionDimensions;
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(R)
    .where(and(eq(R.tenantId, tenantId), eq(R.dimensionId, dimensionId)));
  return row?.count ?? 0;
}

/** 名称模糊查询：转义通配符，按字面匹配。 */
function nameLike(column: AnyPgColumn, value: string): SQL {
  return sql`${column} ILIKE ${`%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}`;
}
