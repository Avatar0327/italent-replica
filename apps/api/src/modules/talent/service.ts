/**
 * 人才标准的写入（docs/02_业务建模/23 §2.2）。每个写入在命令台账的同一租户事务里完成“业务写 + 审计”（DEC-019 / 216）。
 * 取锁顺序：人才标准 → 指标 → 指标库（标准保存时对引用的指标与指标库加 FOR SHARE；停用 / 删除指标、指标库先 FOR UPDATE），
 * 因此“停用后不可新引用”（TC-R4）与“被引用不可删”（TC-R5）在并发下同样成立；外键 RESTRICT 兜底。
 */
import {
  and,
  eq,
  pgErrorCode,
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
import { criterionDimensionViolation, type ReferencedDimension, type TalentDimensionType } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import {
  codeOf,
  requireVisible,
  TALENT_LABELS,
  type ModuleScope,
  type TalentContext,
  type TalentObject,
} from './access.js';
import type {
  CategoryCreate,
  CategoryPatch,
  CriterionCreate,
  CriterionDimensionInput,
  CriterionPatch,
  DimensionCreate,
  DimensionPatch,
  LibraryCreate,
  LibraryPatch,
} from './input.js';
import {
  dimensionReferenceCount,
  loadCategory,
  loadCriterion,
  loadDimension,
  loadLibrary,
  type CriterionView,
} from './read-model.js';
import { criterionReferrer } from './references.js';

/** 写入时引用其他对象须各自可见（DEC-178 同口径）；null 表示查看人没有该对象的查看权。 */
export interface ReferenceScopes {
  readonly library?: ModuleScope | null;
  readonly dimension?: ModuleScope | null;
  readonly criterionCategory?: ModuleScope | null;
}

export interface WriteContext extends TalentContext {
  readonly scope: ModuleScope;
  readonly references: ReferenceScopes;
}

const TABLES: Readonly<Record<TalentObject, string>> = {
  library: 'talent_dimension_libraries',
  dimension: 'talent_dimensions',
  criterionCategory: 'talent_criterion_categories',
  criterion: 'talent_criteria',
};
const ACTIONS: Readonly<Record<TalentObject, string>> = {
  library: 'talent.library',
  dimension: 'talent.dimension',
  criterionCategory: 'talent.category',
  criterion: 'talent.criterion',
};

// ---- 指标库 ----

export async function createLibrary(tx: Tx, ctx: WriteContext, input: LibraryCreate) {
  requireVisible(ctx.scope, 'library', ctx.userId);
  const [row] = await tx
    .insert(talentDimensionLibraries)
    .values({ tenantId: ctx.tenantId, ...input, ...created(ctx) })
    .returning({ id: talentDimensionLibraries.id });
  const after = (await loadLibrary(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'library', 'create', after.id, null, after);
  return after;
}

export async function updateLibrary(tx: Tx, ctx: WriteContext, id: string, patch: LibraryPatch) {
  await lockOwned(tx, ctx, 'library', id);
  const before = (await loadLibrary(tx, ctx.tenantId, id))!;
  await tx
    .update(talentDimensionLibraries)
    .set({ ...patch, ...bumped(ctx) })
    .where(and(eq(talentDimensionLibraries.tenantId, ctx.tenantId), eq(talentDimensionLibraries.id, id)));
  const after = (await loadLibrary(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'library', 'update', id, before, after);
  return after;
}

/** TC-R5：还有指标的指标库不能删除（指标是硬删除，删掉的指标不再计入）。 */
export async function deleteLibrary(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'library', id);
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(talentDimensions)
    .where(and(eq(talentDimensions.tenantId, ctx.tenantId), eq(talentDimensions.libraryId, id)));
  if ((row?.count ?? 0) > 0) {
    throw new AppError('CONFLICT', '指标库下还有指标，不能删除', { reason: 'LIBRARY_HAS_DIMENSIONS' });
  }
  const before = (await loadLibrary(tx, ctx.tenantId, id))!;
  await tx
    .delete(talentDimensionLibraries)
    .where(and(eq(talentDimensionLibraries.tenantId, ctx.tenantId), eq(talentDimensionLibraries.id, id)));
  await audit(tx, ctx, 'library', 'delete', id, before, null);
  return before;
}

// ---- 指标 ----

export async function createDimension(tx: Tx, ctx: WriteContext, input: DimensionCreate) {
  requireVisible(ctx.scope, 'dimension', ctx.userId);
  await referencedLibrary(tx, ctx, input.libraryId);
  await requireUniqueCode(tx, ctx.tenantId, input.code);
  const { grades, behaviors, suggestions, questions, ...fields } = input;
  const [row] = await unique(() =>
    tx
      .insert(talentDimensions)
      .values({ tenantId: ctx.tenantId, ...fields, ...created(ctx) })
      .returning({ id: talentDimensions.id }),
  );
  await replaceDetails(tx, ctx.tenantId, row!.id, { grades, behaviors, suggestions, questions });
  const after = (await loadDimension(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'dimension', 'create', after.id, null, after);
  return after;
}

export async function updateDimension(tx: Tx, ctx: WriteContext, id: string, patch: DimensionPatch) {
  await lockOwned(tx, ctx, 'dimension', id);
  const before = (await loadDimension(tx, ctx.tenantId, id))!;
  const { grades, behaviors, suggestions, questions, ...fields } = patch;
  if (fields.code !== undefined && fields.code !== before.code) await requireUniqueCode(tx, ctx.tenantId, fields.code);
  await unique(() =>
    tx
      .update(talentDimensions)
      .set({ ...fields, ...bumped(ctx) })
      .where(and(eq(talentDimensions.tenantId, ctx.tenantId), eq(talentDimensions.id, id))),
  );
  await replaceDetails(tx, ctx.tenantId, id, { grades, behaviors, suggestions, questions });
  const after = (await loadDimension(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'dimension', 'update', id, before, after);
  return after;
}

/** TC-R5：被人才标准引用的指标不能删除（先持指标行锁，再数引用，与并发的新引用串行）。 */
export async function deleteDimension(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'dimension', id);
  if ((await dimensionReferenceCount(tx, ctx.tenantId, id)) > 0) {
    throw new AppError('CONFLICT', '指标已被人才标准引用，不能删除', { reason: 'DIMENSION_REFERENCED' });
  }
  const before = (await loadDimension(tx, ctx.tenantId, id))!;
  await tx
    .delete(talentDimensions)
    .where(and(eq(talentDimensions.tenantId, ctx.tenantId), eq(talentDimensions.id, id)));
  await audit(tx, ctx, 'dimension', 'delete', id, before, null);
  return before;
}

// ---- 人才标准分类 ----

export async function createCategory(tx: Tx, ctx: WriteContext, input: CategoryCreate) {
  requireVisible(ctx.scope, 'criterionCategory', ctx.userId);
  const [row] = await tx
    .insert(talentCriterionCategories)
    .values({ tenantId: ctx.tenantId, ...input, ...created(ctx) })
    .returning({ id: talentCriterionCategories.id });
  const after = (await loadCategory(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'criterionCategory', 'create', after.id, null, after);
  return after;
}

export async function updateCategory(tx: Tx, ctx: WriteContext, id: string, patch: CategoryPatch) {
  await lockOwned(tx, ctx, 'criterionCategory', id);
  const before = (await loadCategory(tx, ctx.tenantId, id))!;
  await tx
    .update(talentCriterionCategories)
    .set({ ...patch, ...bumped(ctx) })
    .where(and(eq(talentCriterionCategories.tenantId, ctx.tenantId), eq(talentCriterionCategories.id, id)));
  const after = (await loadCategory(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'criterionCategory', 'update', id, before, after);
  return after;
}

/** 分类下还有人才标准时不能删除（外键 RESTRICT 兜底）。TODO(需取证 #103): 规格未写，暂按不留孤儿标准处理。 */
export async function deleteCategory(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'criterionCategory', id);
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(talentCriteria)
    .where(and(eq(talentCriteria.tenantId, ctx.tenantId), eq(talentCriteria.categoryId, id)));
  if ((row?.count ?? 0) > 0) {
    throw new AppError('CONFLICT', '分类下还有人才标准，不能删除', { reason: 'CATEGORY_HAS_CRITERIA' });
  }
  const before = (await loadCategory(tx, ctx.tenantId, id))!;
  await tx
    .delete(talentCriterionCategories)
    .where(and(eq(talentCriterionCategories.tenantId, ctx.tenantId), eq(talentCriterionCategories.id, id)));
  await audit(tx, ctx, 'criterionCategory', 'delete', id, before, null);
  return before;
}

// ---- 人才标准 ----

export async function createCriterion(tx: Tx, ctx: WriteContext, input: CriterionCreate) {
  requireVisible(ctx.scope, 'criterion', ctx.userId);
  await referencedCategory(tx, ctx, input.categoryId);
  const { dimensions = [], ...fields } = input;
  await checkReferences(tx, ctx, dimensions, new Set());
  const [row] = await tx
    .insert(talentCriteria)
    .values({ tenantId: ctx.tenantId, ...fields, ...created(ctx) })
    .returning({ id: talentCriteria.id });
  await replaceReferences(tx, ctx.tenantId, row!.id, dimensions);
  const after = (await loadCriterion(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'criterion', 'create', after.id, null, auditCriterion(after));
  return after;
}

export async function updateCriterion(tx: Tx, ctx: WriteContext, id: string, patch: CriterionPatch) {
  await lockOwned(tx, ctx, 'criterion', id);
  const before = (await loadCriterion(tx, ctx.tenantId, id))!;
  const { dimensions, ...fields } = patch;
  if (fields.categoryId !== undefined && fields.categoryId !== before.categoryId) {
    await referencedCategory(tx, ctx, fields.categoryId);
  }
  if (dimensions) {
    await checkReferences(tx, ctx, dimensions, new Set(before.dimensions.map((item) => item.dimensionId)));
  }
  await tx
    .update(talentCriteria)
    .set({ ...fields, ...bumped(ctx) })
    .where(and(eq(talentCriteria.tenantId, ctx.tenantId), eq(talentCriteria.id, id)));
  if (dimensions) await replaceReferences(tx, ctx.tenantId, id, dimensions);
  const after = (await loadCriterion(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'criterion', 'update', id, auditCriterion(before), auditCriterion(after));
  return after;
}

export async function deleteCriterion(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'criterion', id);
  const referrer = await criterionReferrer(tx, ctx.tenantId, id);
  if (referrer) {
    throw new AppError('CONFLICT', '人才标准已被引用，不能删除', { reason: 'CRITERION_REFERENCED', referrer });
  }
  const before = (await loadCriterion(tx, ctx.tenantId, id))!;
  await tx.delete(talentCriteria).where(and(eq(talentCriteria.tenantId, ctx.tenantId), eq(talentCriteria.id, id)));
  await audit(tx, ctx, 'criterion', 'delete', id, auditCriterion(before), null);
  return before;
}

/**
 * 引用的指标：先对指标与所属指标库加共享锁再读状态（与停用 / 删除串行，TC-R4 / R5），再按领域规则判定。
 * 新增引用的指标须在查看人的指标范围内；已有引用不重新判定范围与启用状态。
 */
async function checkReferences(
  tx: Tx,
  ctx: WriteContext,
  items: readonly CriterionDimensionInput[],
  existing: ReadonlySet<string>,
) {
  const ids = [...new Set(items.map((item) => item.dimensionId))];
  if (!ids.length) return;
  const result = await tx.execute(sql`SELECT d.id, d.enabled, d.created_by, l.type, l.enabled AS library_enabled
    FROM talent_dimensions d JOIN talent_dimension_libraries l ON l.tenant_id = d.tenant_id AND l.id = d.library_id
    WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ANY(${`{${ids.join(',')}}`}::uuid[])
    ORDER BY d.id FOR SHARE`);
  const rows = rowsOf<{
    id: string;
    enabled: boolean;
    created_by: string;
    type: TalentDimensionType;
    library_enabled: boolean;
  }>(result);
  const found = new Map(rows.map((row) => [row.id, row]));
  const fresh = ids.filter((id) => !existing.has(id));
  if (fresh.length && ctx.references.dimension === null) throw new AppError('FORBIDDEN', '无权查看指标');
  for (const id of fresh) {
    const row = found.get(id);
    if (!row) throw new AppError('NOT_FOUND', '指标不存在');
    requireVisible(ctx.references.dimension!, 'dimension', row.created_by);
  }
  const referenced = new Map<string, ReferencedDimension>(
    rows.map((row) => [
      row.id,
      { id: row.id, type: row.type, enabled: row.enabled, libraryEnabled: row.library_enabled },
    ]),
  );
  const violation = criterionDimensionViolation(items, referenced, existing);
  if (violation) throw new AppError('VALIDATION_FAILED', VIOLATION_MESSAGES[violation.reason], violation);
}

const VIOLATION_MESSAGES = {
  DUPLICATE_DIMENSION: '同一人才标准里不能重复引用同一指标',
  DIMENSION_NOT_ENABLED: '只能引用已启用的指标与指标库',
  WEIGHT_TARGET_ABILITY_ONLY: '只有能力指标可以设置权重和目标',
} as const;

async function replaceReferences(
  tx: Tx,
  tenantId: string,
  criterionId: string,
  items: readonly CriterionDimensionInput[],
) {
  const R = talentCriterionDimensions;
  await tx.delete(R).where(and(eq(R.tenantId, tenantId), eq(R.criterionId, criterionId)));
  if (!items.length) return;
  await tx.insert(R).values(
    items.map((item, index) => ({
      tenantId,
      criterionId,
      dimensionId: item.dimensionId,
      weight: item.weight === undefined || item.weight === null ? null : item.weight.toFixed(2),
      target: item.target === undefined || item.target === null ? null : item.target.toFixed(2),
      displayOrder: item.displayOrder ?? index + 1,
    })),
  );
}

/** 指标的四类明细：提交了哪组就整组替换哪组，未提交的保持不变。 */
async function replaceDetails(
  tx: Tx,
  tenantId: string,
  dimensionId: string,
  details: Pick<DimensionPatch, 'grades' | 'behaviors' | 'suggestions' | 'questions'>,
) {
  const ordered = <T extends { displayOrder?: number | undefined }>(items: readonly T[]) =>
    items.map((item, index) => ({ ...item, displayOrder: item.displayOrder ?? index + 1, tenantId, dimensionId }));
  const tables = [
    [talentDimensionGrades, details.grades?.map((item) => ({ ...item, tenantId, dimensionId }))],
    [talentDimensionBehaviors, details.behaviors && ordered(details.behaviors)],
    [talentDimensionSuggestions, details.suggestions && ordered(details.suggestions)],
    [talentDimensionQuestions, details.questions && ordered(details.questions)],
  ] as const;
  for (const [table, rows] of tables) {
    if (!rows) continue;
    await tx.delete(table).where(and(eq(table.tenantId, tenantId), eq(table.dimensionId, dimensionId)));
    if (rows.length) await tx.insert(table).values(rows as never);
  }
}

/** 引用的指标库须存在、在查看人的指标库范围内（共享锁：与删除指标库串行）。 */
async function referencedLibrary(tx: Tx, ctx: WriteContext, libraryId: string) {
  if (ctx.references.library === null) throw new AppError('FORBIDDEN', '无权查看指标库');
  const creator = await lockedCreator(tx, 'library', ctx.tenantId, libraryId, 'SHARE');
  if (!creator) throw new AppError('NOT_FOUND', '指标库不存在');
  requireVisible(ctx.references.library!, 'library', creator);
}

async function referencedCategory(tx: Tx, ctx: WriteContext, categoryId: string) {
  if (ctx.references.criterionCategory === null) throw new AppError('FORBIDDEN', '无权查看人才标准分类');
  const creator = await lockedCreator(tx, 'criterionCategory', ctx.tenantId, categoryId, 'SHARE');
  if (!creator) throw new AppError('NOT_FOUND', '人才标准分类不存在');
  requireVisible(ctx.references.criterionCategory!, 'criterionCategory', creator);
}

/** 行锁 → 范围（范围外与不存在同样 404）→ revision。 */
async function lockOwned(tx: Tx, ctx: WriteContext, object: TalentObject, id: string) {
  const result = await tx.execute(sql`SELECT revision, created_by FROM ${sql.identifier(TABLES[object])}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid FOR UPDATE`);
  const [row] = rowsOf<{ revision: number; created_by: string }>(result);
  if (!row) throw new AppError('NOT_FOUND', `${TALENT_LABELS[object]}不存在`);
  requireVisible(ctx.scope, object, row.created_by);
  if (row.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', `${TALENT_LABELS[object]}已变更，请刷新后显式重提`, {
      expected: ctx.expectedRevision,
      actual: row.revision,
    });
  }
}

async function lockedCreator(tx: Tx, object: TalentObject, tenantId: string, id: string, mode: 'SHARE') {
  const result = await tx.execute(sql`SELECT created_by FROM ${sql.identifier(TABLES[object])}
    WHERE tenant_id = ${tenantId} AND id = ${id}::uuid FOR ${sql.raw(mode)}`);
  return rowsOf<{ created_by: string }>(result)[0]?.created_by;
}

async function requireUniqueCode(tx: Tx, tenantId: string, code: string) {
  const [row] = await tx
    .select({ id: talentDimensions.id })
    .from(talentDimensions)
    .where(and(eq(talentDimensions.tenantId, tenantId), eq(talentDimensions.code, code)));
  if (row) throw new AppError('CONFLICT', '指标编码已存在', { reason: 'DIMENSION_CODE_TAKEN' });
}

async function unique<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') {
      throw new AppError('CONFLICT', '指标编码已存在', { reason: 'DIMENSION_CODE_TAKEN' });
    }
    throw error;
  }
}

/** 审计只记引用本身（指标 ID、类型、权重、目标、顺序），不把指标内容当作标准的字段（TC-R2）。 */
function auditCriterion(view: CriterionView) {
  return { ...view, dimensions: view.dimensions.map(({ dimension: _content, ...reference }) => reference) };
}

async function audit(
  tx: Tx,
  ctx: TalentContext,
  object: TalentObject,
  operation: 'create' | 'update' | 'delete',
  id: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

const created = (ctx: TalentContext) => ({ createdBy: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now });
const bumped = (ctx: TalentContext) => ({ revision: ctx.expectedRevision + 1, updatedAt: ctx.now });

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
