/**
 * 指标库、指标库内分类（DEC-281③）与发展建议类型（DEC-281④）的写入。
 * - 指标库挂所属管理单元（建后不可改），库内分类随所属指标库；
 * - TC-R5：还有指标或分类的指标库不能删除；被指标引用的分类、被发展建议引用的类型不能删除（🟡 原站未取证，不留孤儿）。
 */
import {
  and,
  eq,
  pgErrorCode,
  talentDescriptionTypes,
  talentDimensionCategories,
  talentDimensionLibraries,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { requireVisible } from './access.js';
import type {
  DescriptionTypeCreate,
  DescriptionTypePatch,
  DimensionCategoryCreate,
  DimensionCategoryPatch,
  LibraryCreate,
  LibraryPatch,
} from './input.js';
import { loadDescriptionType, loadDimensionCategory, loadLibrary } from './read-model.js';
import {
  audit,
  bumped,
  created,
  lockOwned,
  owned,
  referenced,
  rejectInUse,
  requireOwnerOrg,
  type WriteContext,
} from './write-support.js';

// ---- 指标库 ----

export async function createLibrary(tx: Tx, ctx: WriteContext, input: LibraryCreate) {
  await requireOwnerOrg(tx, ctx, 'library', input.ownerOrgId);
  const { ownerOrgId, ...fields } = input;
  const [row] = await tx
    .insert(talentDimensionLibraries)
    .values({ tenantId: ctx.tenantId, ...fields, ...owned(ctx, ownerOrgId), ...created(ctx) })
    .returning({ id: talentDimensionLibraries.id });
  const after = (await loadLibrary(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'library', 'create', after.id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

export async function updateLibrary(tx: Tx, ctx: WriteContext, id: string, patch: LibraryPatch) {
  await lockOwned(tx, ctx, 'library', id);
  const before = (await loadLibrary(tx, ctx.tenantId, id))!;
  const L = talentDimensionLibraries;
  await tx
    .update(L)
    .set({ ...patch, ...bumped(ctx) })
    .where(and(eq(L.tenantId, ctx.tenantId), eq(L.id, id)));
  const after = (await loadLibrary(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'library', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

/**
 * TC-R5：还有指标的指标库不能删除（指标是硬删除，删掉的不再计入）；库里还有分类同样不能删除
 * （TODO(需取证 #109): 原站有分类的库能否删除未取证）。
 */
export async function deleteLibrary(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'library', id);
  await rejectInUse(tx, ctx, {
    table: 'talent_dimensions',
    column: 'library_id',
    id,
    reason: 'LIBRARY_HAS_DIMENSIONS',
    message: '指标库下还有指标，不能删除',
  });
  await rejectInUse(tx, ctx, {
    table: 'talent_dimension_categories',
    column: 'library_id',
    id,
    reason: 'LIBRARY_HAS_CATEGORIES',
    message: '指标库下还有分类，不能删除',
  });
  const before = (await loadLibrary(tx, ctx.tenantId, id))!;
  const L = talentDimensionLibraries;
  await tx.delete(L).where(and(eq(L.tenantId, ctx.tenantId), eq(L.id, id)));
  await audit(tx, ctx, 'library', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}

// ---- 指标库内分类 ----

export async function createDimensionCategory(tx: Tx, ctx: WriteContext, input: DimensionCategoryCreate) {
  const library = await referenced(tx, ctx, 'library', input.libraryId);
  requireVisible(ctx.scope, 'dimensionCategory', { orgId: library.orgId, ownerId: ctx.userId });
  const [row] = await tx
    .insert(talentDimensionCategories)
    .values({ tenantId: ctx.tenantId, ...input, ...owned(ctx, library.orgId!), ...created(ctx) })
    .returning({ id: talentDimensionCategories.id });
  const after = (await loadDimensionCategory(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'dimensionCategory', 'create', after.id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

export async function updateDimensionCategory(tx: Tx, ctx: WriteContext, id: string, patch: DimensionCategoryPatch) {
  await lockOwned(tx, ctx, 'dimensionCategory', id);
  const before = (await loadDimensionCategory(tx, ctx.tenantId, id))!;
  const K = talentDimensionCategories;
  await tx
    .update(K)
    .set({ ...patch, ...bumped(ctx) })
    .where(and(eq(K.tenantId, ctx.tenantId), eq(K.id, id)));
  const after = (await loadDimensionCategory(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'dimensionCategory', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

/** 被指标引用的分类不能删除（指标的分类查找字段会悬空）。TODO(需取证 #109): 原站删除被引用分类的行为未取证。 */
export async function deleteDimensionCategory(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'dimensionCategory', id);
  await rejectInUse(tx, ctx, {
    table: 'talent_dimensions',
    column: 'category_id',
    id,
    reason: 'DIMENSION_CATEGORY_IN_USE',
    message: '分类下还有指标，不能删除',
  });
  const before = (await loadDimensionCategory(tx, ctx.tenantId, id))!;
  const K = talentDimensionCategories;
  await tx.delete(K).where(and(eq(K.tenantId, ctx.tenantId), eq(K.id, id)));
  await audit(tx, ctx, 'dimensionCategory', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}

// ---- 发展建议类型（字典：只认看全部或创建人） ----

export async function createDescriptionType(tx: Tx, ctx: WriteContext, input: DescriptionTypeCreate) {
  requireVisible(ctx.scope, 'descriptionType', { ownerId: ctx.userId });
  const [row] = await uniqueName(() =>
    tx
      .insert(talentDescriptionTypes)
      .values({ tenantId: ctx.tenantId, ...input, ...created(ctx) })
      .returning({ id: talentDescriptionTypes.id }),
  );
  const after = (await loadDescriptionType(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'descriptionType', 'create', after.id, { before: null, after });
  return after;
}

export async function updateDescriptionType(tx: Tx, ctx: WriteContext, id: string, patch: DescriptionTypePatch) {
  await lockOwned(tx, ctx, 'descriptionType', id);
  const before = (await loadDescriptionType(tx, ctx.tenantId, id))!;
  const T = talentDescriptionTypes;
  await uniqueName(() =>
    tx
      .update(T)
      .set({ ...patch, ...bumped(ctx) })
      .where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id))),
  );
  const after = (await loadDescriptionType(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'descriptionType', 'update', id, { before, after });
  return after;
}

/** 被发展建议引用的类型不能删除（可以停用：停用后不能新选用，已有行保留）。 */
export async function deleteDescriptionType(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'descriptionType', id);
  await rejectInUse(tx, ctx, {
    table: 'talent_dimension_suggestions',
    column: 'type_id',
    id,
    reason: 'DESCRIPTION_TYPE_IN_USE',
    message: '发展建议类型已被使用，不能删除',
  });
  const before = (await loadDescriptionType(tx, ctx.tenantId, id))!;
  const T = talentDescriptionTypes;
  await tx.delete(T).where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)));
  await audit(tx, ctx, 'descriptionType', 'delete', id, { before, after: null });
  return before;
}

async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') {
      throw new AppError('CONFLICT', '发展建议类型名称已存在', { reason: 'DESCRIPTION_TYPE_NAME_TAKEN' });
    }
    throw error;
  }
}
