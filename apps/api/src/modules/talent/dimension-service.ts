/**
 * 指标的写入（docs/02_业务建模/23 §2.1、§7；DEC-281）。
 * - 所属指标库建后不可改，编码建后只读（DEC-281⑤⑥）；所属人 / 所属管理单元由系统按创建人填写（DEC-294③）；
 *   在库下新建时库的所属管理单元须在操作人的管理范围内（DEC-082）；
 * - 编码、名称都在库内唯一，重复时照原站提示“名称或者编码重复，请重新输入”（W-577 / W-578）；
 * - 分类只能引用同一指标库的分类（DEC-281③，外键兜底）；
 * - 四类明细整组替换；发展建议的类型须取自类型数据源，新选用的类型须已启用；建议行带行身份，原来就是某个停用类型
 *   且类型没改的那一行可以保留（DEC-281④、DEC-297②）；
 * - TC-R5：被人才标准引用的指标不能删除；停用不拦截（DEC-281⑧，只拦新引用）。
 */
import {
  and,
  eq,
  ne,
  pgErrorCode,
  sql,
  talentDimensionBehaviors,
  talentDimensionGrades,
  talentDimensionQuestions,
  talentDimensions,
  talentDimensionSuggestions,
  type Tx,
} from '@italent/db';
import { TALENT_DUPLICATE_MESSAGE } from '@italent/domain';
import { or } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import type { DimensionCreate, DimensionPatch, SuggestionInput } from './input.js';
import { ownerUnit } from './owner-units.js';
import { loadDimension } from './read-model.js';
import {
  audit,
  bumped,
  created,
  lockOwned,
  owned,
  referenced,
  rejectInUse,
  requireLibraryCreatable,
  rowsOf,
  type WriteContext,
} from './write-support.js';

const D = talentDimensions;
type Details = Pick<DimensionPatch, 'grades' | 'behaviors' | 'suggestions' | 'questions'>;

export async function createDimension(tx: Tx, ctx: WriteContext, input: DimensionCreate) {
  const library = await referenced(tx, ctx, 'library', input.libraryId);
  requireLibraryCreatable(ctx, 'dimension', library);
  const { grades, behaviors, suggestions, questions, ownerOrgId: requested, ...fields } = input;
  const ownerOrgId = await ownerUnit(tx, ctx, 'dimension', requested);
  if (input.categoryId) await referencedCategory(tx, ctx, input.libraryId, input.categoryId);
  await requireUnique(tx, ctx.tenantId, input.libraryId, { code: input.code, name: input.name });
  await checkSuggestionTypes(tx, ctx, suggestions, []);
  const [row] = await duplicate(() =>
    tx
      .insert(D)
      .values({ tenantId: ctx.tenantId, ...fields, ...owned(ctx, ownerOrgId), ...created(ctx) })
      .returning({ id: D.id }),
  );
  await replaceDetails(tx, ctx.tenantId, row!.id, { grades, behaviors, suggestions, questions });
  const after = (await loadDimension(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'dimension', 'create', after.id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

export async function updateDimension(tx: Tx, ctx: WriteContext, id: string, patch: DimensionPatch) {
  await lockOwned(tx, ctx, 'dimension', id);
  const before = (await loadDimension(tx, ctx.tenantId, id))!;
  const { grades, behaviors, suggestions, questions, ...fields } = patch;
  if (fields.categoryId && fields.categoryId !== before.categoryId) {
    await referencedCategory(tx, ctx, before.libraryId, fields.categoryId);
  }
  if (fields.name !== undefined && fields.name !== before.name) {
    await requireUnique(tx, ctx.tenantId, before.libraryId, { name: fields.name }, id);
  }
  await checkSuggestionTypes(tx, ctx, suggestions, before.suggestions);
  await duplicate(() =>
    tx
      .update(D)
      .set({ ...fields, ...bumped(ctx) })
      .where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, id))),
  );
  await replaceDetails(tx, ctx.tenantId, id, { grades, behaviors, suggestions, questions });
  const after = (await loadDimension(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'dimension', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

/** TC-R5：被人才标准引用的指标不能删除（先持指标行锁，再数引用，与并发的新引用串行）。 */
export async function deleteDimension(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'dimension', id);
  await rejectInUse(tx, ctx, {
    table: 'talent_criterion_dimensions',
    column: 'dimension_id',
    id,
    reason: 'DIMENSION_REFERENCED',
    message: '指标已被人才标准引用，不能删除',
  });
  const before = (await loadDimension(tx, ctx.tenantId, id))!;
  await tx.delete(D).where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, id)));
  await audit(tx, ctx, 'dimension', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}

/** 指标的分类查找字段：分类须可见（范围外 404），且属于同一指标库（DEC-281③）。 */
async function referencedCategory(tx: Tx, ctx: WriteContext, libraryId: string, categoryId: string) {
  await referenced(tx, ctx, 'dimensionCategory', categoryId);
  const result = await tx.execute(sql`SELECT library_id FROM talent_dimension_categories
    WHERE tenant_id = ${ctx.tenantId} AND id = ${categoryId}::uuid`);
  if (rowsOf<{ library_id: string }>(result)[0]?.library_id !== libraryId) {
    throw new AppError('VALIDATION_FAILED', '只能选择本指标库的分类', { reason: 'CATEGORY_LIBRARY_MISMATCH' });
  }
}

/** DEC-281⑤：编码、名称在库内唯一（跨库可以重复）；并发写入由唯一约束兜底，同样给出原站提示。 */
async function requireUnique(
  tx: Tx,
  tenantId: string,
  libraryId: string,
  value: { code?: string; name?: string },
  exceptId?: string,
) {
  const clash = or(
    value.code === undefined ? undefined : eq(D.code, value.code),
    value.name === undefined ? undefined : eq(D.name, value.name),
  );
  const [row] = await tx
    .select({ id: D.id })
    .from(D)
    .where(and(eq(D.tenantId, tenantId), eq(D.libraryId, libraryId), clash, exceptId ? ne(D.id, exceptId) : undefined))
    .limit(1);
  if (row) throw duplicateError();
}

const duplicateError = () => new AppError('CONFLICT', TALENT_DUPLICATE_MESSAGE, { reason: 'NAME_OR_CODE_DUPLICATE' });

async function duplicate<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw duplicateError();
    throw error;
  }
}

/**
 * 发展建议的类型与行身份（DEC-281④、DEC-297②，第 5 轮清单 1）：
 * - 带 id 的行须是本指标已有的建议行（不重复），不带 id 的是新增行；
 * - 类型须是本租户类型数据源里的类型；已停用的类型只能留在“原来就是该类型、而且类型没改”的那一行，新增行或改选成
 *   停用类型的行一律 400（停用政策为 #109③ 暂定口径）。
 * 共享锁与删除类型串行（被引用的类型不能删除）。类型是下拉选项，不按类型字典的数据范围裁剪。
 */
async function checkSuggestionTypes(
  tx: Tx,
  ctx: WriteContext,
  suggestions: readonly SuggestionInput[] | undefined,
  existing: readonly { readonly id: string; readonly typeId: string }[],
) {
  if (!suggestions?.length) return;
  const original = new Map(existing.map((row) => [row.id, row.typeId]));
  const rowIds = suggestions.flatMap((item) => (item.id ? [item.id] : []));
  if (new Set(rowIds).size !== rowIds.length || rowIds.some((id) => !original.has(id))) {
    throw new AppError('VALIDATION_FAILED', '发展建议行不存在或重复', { reason: 'SUGGESTION_ROW_INVALID' });
  }
  const ids = [...new Set(suggestions.map((item) => item.typeId))];
  const result = await tx.execute(sql`SELECT id, enabled FROM talent_description_types
    WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY id FOR SHARE`);
  const found = new Map(rowsOf<{ id: string; enabled: boolean }>(result).map((row) => [row.id, row.enabled]));
  for (const item of suggestions) {
    const enabled = found.get(item.typeId);
    const kept = item.id !== undefined && original.get(item.id) === item.typeId;
    if (enabled === undefined || (!enabled && !kept)) {
      throw new AppError('VALIDATION_FAILED', '发展建议类型不存在或已停用', {
        reason: 'DESCRIPTION_TYPE_INVALID',
        typeId: item.typeId,
      });
    }
  }
}

/** 指标的四类明细：提交了哪组就整组替换哪组，未提交的保持不变。 */
async function replaceDetails(tx: Tx, tenantId: string, dimensionId: string, details: Details) {
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
