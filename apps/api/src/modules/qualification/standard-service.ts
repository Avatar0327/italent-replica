/**
 * 任职资格标准（docs/02_业务建模/23 §3.2 QL-R5、R8～R13、R18；设计 §3.1、§5.2）。
 * - 一个类别只对应一条标准（QL-R8）；资源集合随类别（系统复制）；类别须在操作人写范围内（§5.2 #5）；
 * - 级别范围建后不可改（QL-R18）；网格 = 级别 × 指标，每格 1–10 条能力标准（QL-R9 / R10）；`details` 是整组：
 *   请求里的格即全部格，未列出的删除；某格省略 `abilities` 时保留原有、新格按指标带入；
 * - 带入（QL-R5，§5.2 #1）：非通用指标的说明只在新格带入一次，且只有操作人当前对 Target.description 有查看权才复制，
 *   否则留空；通用指标的格由指标说明覆盖写入（DEC-334①），不可编辑（409 ABILITY_LOCKED_BY_COMMON）；
 * - 编辑导入（QL-R11、AC-QL-05）：一行一条能力标准，按格先删后建；编码只在导入人的读取范围内解析，范围外与不存在
 *   同一回执；任一行有误整批回滚并逐行回执；
 * - 发展通道（QL-R13）：纵向由级别顺序生成，横向逐条维护（整组替换）。
 */
import { sql, type Tx } from '@italent/db';
import { recordImportLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { accessSql, codeOf, fieldVisible, qlReadable, requireEditable } from './access.js';
import { MAX_ABILITIES, type Cell } from './input.js';
import type * as input from './input.js';
import { loadRow, withStandardParts, type DetailRow, type StandardView } from './read-model.js';
import {
  audit,
  bumped,
  deleteChildren,
  guardUnique,
  lockEditable,
  referenced,
  rowAccess,
  rowsOf,
  type WriteContext,
} from './store.js';

async function reloadStandard(tx: Tx, ctx: WriteContext, id: string): Promise<StandardView> {
  return (await withStandardParts(tx, ctx.tenantId, [(await loadRow(tx, ctx.tenantId, 'standard', id))!]))[0]!;
}

const key = (levelId: string, targetId: string) => `${levelId}|${targetId}`;

interface TargetRow {
  readonly id: string;
  readonly is_common: boolean;
  readonly description: string | null;
  readonly eval_mode: string;
  readonly grade_scheme_id: string | null;
}

/** 能力标准的可比较形状（判断“未改动”）。 */
const shape = (a: {
  content?: string;
  targetValue?: string | null;
  targetGradeId?: string | null;
  weight?: number | null;
}) => JSON.stringify([a.content ?? '', a.targetValue ?? null, a.targetGradeId ?? null, a.weight ?? null]);

async function checkGrades(tx: Tx, ctx: WriteContext, target: TargetRow, abilities: NonNullable<Cell['abilities']>) {
  for (const ability of abilities) {
    if (!ability.targetGradeId) continue;
    if (target.eval_mode !== 'grade') {
      throw new AppError('VALIDATION_FAILED', '只有评级指标才能设置目标等级', { reason: 'TARGET_GRADE_NOT_ALLOWED' });
    }
    // 锁住等级明细再判断（锁序 标准 → 指标 → 等级明细，P2-07）：明细正被软删时等其提交，按提交后的状态判断
    const ok = rowsOf<{ deleted_at: unknown }>(
      await tx.execute(sql`SELECT deleted_at FROM ql_grade_details WHERE tenant_id = ${ctx.tenantId}
        AND id = ${ability.targetGradeId}::uuid AND scheme_id = ${target.grade_scheme_id}::uuid FOR SHARE`),
    );
    if (!ok.length || ok[0]!.deleted_at !== null)
      throw new AppError('VALIDATION_FAILED', '目标等级不属于该指标的等级方案', { reason: 'TARGET_GRADE_INVALID' });
  }
}

async function insertAbilities(
  tx: Tx,
  ctx: WriteContext,
  detailId: string,
  rows: {
    content: string;
    targetValue?: string | null;
    targetGradeId?: string | null;
    weight?: number | null;
    source: string;
    sourceTargetId: string | null;
  }[],
) {
  for (const [index, row] of rows.entries()) {
    await tx.execute(sql`INSERT INTO ql_ability_details (tenant_id, detail_id, content, target_value, target_grade_id,
        weight, display_order, source, source_target_id)
      VALUES (${ctx.tenantId}, ${detailId}, ${row.content}, ${row.targetValue ?? null}, ${row.targetGradeId ?? null},
        ${row.weight ?? null}, ${index}, ${row.source}, ${row.sourceTargetId})`);
  }
}

/** 新格的缺省能力标准：通用指标覆盖写入；非通用指标按操作人对说明的查看权复制一次，否则留空（§5.2 #1）。 */
function defaultAbilities(ctx: WriteContext, target: TargetRow) {
  if (target.is_common) {
    return [{ content: target.description ?? '', source: 'common_overwrite', sourceTargetId: target.id }];
  }
  if (target.description && fieldVisible(ctx.fields.target, 'description')) {
    return [{ content: target.description, source: 'copied', sourceTargetId: target.id }];
  }
  return [{ content: '', source: 'manual', sourceTargetId: null }];
}

/** 写网格（整组）：校验级别在范围内、指标可引用（新引用须启用）、通用格不可改；未列出的格删除。 */
async function writeCells(
  tx: Tx,
  ctx: WriteContext,
  standardId: string,
  levelIds: readonly string[],
  cells: readonly Cell[],
  existing: readonly DetailRow[],
) {
  const current = new Map(existing.map((detail) => [key(detail.levelId, detail.targetId), detail]));
  const referencedTargets = new Set(existing.map((detail) => detail.targetId));
  const seen = new Set<string>();
  for (const cell of cells) {
    if (!levelIds.includes(cell.levelId)) {
      throw new AppError('VALIDATION_FAILED', '级别不在该标准的级别范围内', { reason: 'LEVEL_NOT_IN_STANDARD' });
    }
    const cellKey = key(cell.levelId, cell.targetId);
    if (seen.has(cellKey)) throw new AppError('VALIDATION_FAILED', '同一级别下指标重复', { reason: 'DUPLICATE_CELL' });
    seen.add(cellKey);
  }
  for (const [cellKey, detail] of current) {
    if (seen.has(cellKey)) continue;
    await tx.execute(
      sql`DELETE FROM ql_standard_details WHERE tenant_id = ${ctx.tenantId} AND id = ${detail.id}::uuid`,
    );
  }
  for (const cell of cells) {
    const target = (await referenced(
      tx,
      ctx,
      'target',
      cell.targetId,
      !referencedTargets.has(cell.targetId),
    )) as unknown as TargetRow;
    const before = current.get(key(cell.levelId, cell.targetId));
    let detailId = before?.id;
    if (detailId) {
      await tx.execute(sql`UPDATE ql_standard_details SET target_value = ${cell.targetValue ?? null},
        weight = ${cell.weight ?? null}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${detailId}::uuid`);
    } else {
      detailId = rowsOf<{ id: string }>(
        await tx.execute(sql`INSERT INTO ql_standard_details (tenant_id, standard_id, level_id, target_id,
          target_value, weight)
          VALUES (${ctx.tenantId}, ${standardId}, ${cell.levelId}, ${cell.targetId}, ${cell.targetValue ?? null},
            ${cell.weight ?? null}) RETURNING id`),
      )[0]!.id;
    }
    if (!cell.abilities) {
      if (!before) await insertAbilities(tx, ctx, detailId, defaultAbilities(ctx, target));
      continue;
    }
    const unchanged =
      before &&
      before.abilities.length === cell.abilities.length &&
      before.abilities.every((ability, index) => shape(ability) === shape(cell.abilities![index]!));
    if (unchanged) continue;
    if (target.is_common) {
      throw new AppError('CONFLICT', '通用指标的能力标准取自指标说明，不能编辑', {
        reason: 'ABILITY_LOCKED_BY_COMMON',
      });
    }
    await checkGrades(tx, ctx, target, cell.abilities);
    await tx.execute(
      sql`DELETE FROM ql_ability_details WHERE tenant_id = ${ctx.tenantId} AND detail_id = ${detailId}::uuid`,
    );
    await insertAbilities(
      tx,
      ctx,
      detailId,
      cell.abilities.map((ability) => ({
        ...ability,
        content: ability.content ?? '',
        source: 'manual',
        sourceTargetId: null,
      })),
    );
  }
}

async function writeLevelDescriptions(
  tx: Tx,
  ctx: WriteContext,
  standardId: string,
  levelIds: readonly string[],
  descriptions: input.StandardCreate['levelDescriptions'],
) {
  await tx.execute(
    sql`DELETE FROM ql_level_descriptions WHERE tenant_id = ${ctx.tenantId} AND standard_id = ${standardId}::uuid`,
  );
  for (const item of descriptions ?? []) {
    if (!levelIds.includes(item.levelId)) {
      throw new AppError('VALIDATION_FAILED', '级别不在该标准的级别范围内', { reason: 'LEVEL_NOT_IN_STANDARD' });
    }
    await tx.execute(sql`INSERT INTO ql_level_descriptions (tenant_id, standard_id, level_id, description)
      VALUES (${ctx.tenantId}, ${standardId}, ${item.levelId}, ${item.description})
      ON CONFLICT (tenant_id, standard_id, level_id) DO UPDATE SET description = EXCLUDED.description`);
  }
}

const standardExists = () =>
  new AppError('CONFLICT', '该任职类别已有任职资格标准，一个类别只能对应一条标准', { reason: 'STANDARD_EXISTS' });

export async function createStandard(tx: Tx, ctx: WriteContext, body: input.StandardCreate) {
  // 类别须在操作人写范围内（§5.2 #5）：标准的资源集合随类别；仅向下公开可见的类别 403
  const { access, row: category } = await rowAccess(tx, ctx, ctx.scope, 'category', body.categoryId, 'SHARE');
  requireEditable(access, 'category');
  if (category!.enabled === false) {
    throw new AppError('VALIDATION_FAILED', '任职类别已停用，不能引用', { reason: 'REFERENCE_DISABLED' });
  }
  const taken = rowsOf(
    await tx.execute(
      sql`SELECT 1 FROM ql_standards WHERE tenant_id = ${ctx.tenantId} AND category_id = ${body.categoryId}::uuid`,
    ),
  );
  if (taken.length) throw standardExists();
  const levelIds = [...new Set(body.levelIds)];
  for (const levelId of levelIds) await referenced(tx, ctx, 'level', levelId);
  // 同一类别并发建标准：唯一约束兜底，同样 409（P3）
  const inserted = await guardUnique(
    () =>
      tx.execute(sql`INSERT INTO ql_standards (tenant_id, category_id, name, enabled, level_ids, owner_id,
        owner_org_id, created_by, created_at, updated_at)
        VALUES (${ctx.tenantId}, ${body.categoryId}, ${body.name}, ${body.enabled ?? true},
          ${`{${levelIds.join(',')}}`}::uuid[], ${category!.owner_id as string}, ${category!.owner_org_id as string},
          ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
    standardExists,
  );
  const id = rowsOf<{ id: string }>(inserted)[0]!.id;
  await writeCells(tx, ctx, id, levelIds, body.details, []);
  await writeLevelDescriptions(tx, ctx, id, levelIds, body.levelDescriptions);
  const after = await reloadStandard(tx, ctx, id);
  await audit(tx, ctx, 'standard', 'create', id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

export async function updateStandard(tx: Tx, ctx: WriteContext, id: string, body: input.StandardPatch) {
  const row = await lockEditable(tx, ctx, 'standard', id);
  const before = await reloadStandard(tx, ctx, id);
  const bump = bumped(ctx);
  await tx.execute(sql`UPDATE ql_standards SET name = ${body.name ?? (row.name as string)},
    enabled = ${body.enabled ?? (row.enabled as boolean)}, revision = ${bump.revision}, updated_at = ${bump.updatedAt}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  if (body.details) await writeCells(tx, ctx, id, before.levelIds, body.details, before.details);
  if (body.levelDescriptions) await writeLevelDescriptions(tx, ctx, id, before.levelIds, body.levelDescriptions);
  const after = await reloadStandard(tx, ctx, id);
  await audit(tx, ctx, 'standard', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

export async function deleteStandard(tx: Tx, ctx: WriteContext, id: string) {
  await lockEditable(tx, ctx, 'standard', id);
  const before = await reloadStandard(tx, ctx, id);
  // 发展通道随标准级联删除：另需发展通道的删除权，逐条写删除快照（DEC-019 / DEC-338 自检）
  const channels = await loadChannels(tx, ctx.tenantId, id);
  await deleteChildren(
    tx,
    ctx,
    'developmentChannel',
    channels.horizontal.map((channel) => ({
      objectId: id,
      orgId: before.ownerOrgId,
      snapshot: { standardId: id, categoryId: before.categoryId, ...channel },
    })),
  );
  await tx.execute(sql`DELETE FROM ql_standards WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'standard', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}

// ── 编辑导入（QL-R11） ───────────────────────────────────────

export interface ImportReceipt {
  readonly row: number;
  readonly reason: string;
}

interface Resolved {
  readonly standardId: string;
  readonly categoryCode: string;
  readonly levelId: string;
  readonly targetId: string;
}

/** 按编码解析（只在导入人的读取范围内）：类别 → 标准（须可写）、级别（须在标准的级别范围内）、指标（非通用）。 */
async function resolveRows(tx: Tx, ctx: WriteContext, rows: input.StandardImport['rows']) {
  const readableIn = (alias: string, object: 'level' | 'target') => {
    const scope = ctx.scopes[object];
    return scope ? qlReadable(ctx, scope, alias) : sql`false`;
  };
  const categoryAccess = accessSql(ctx, ctx.scope, 'owned', 'c');
  const resolved: (Resolved | undefined)[] = [];
  const receipts: ImportReceipt[] = [];
  for (const [index, row] of rows.entries()) {
    const fail = (reason: string) => {
      receipts.push({ row: index + 1, reason });
      resolved.push(undefined);
    };
    const category = rowsOf<{
      editable: boolean;
      readable: boolean;
      standard_id: string | null;
      level_ids: string[] | null;
    }>(
      await tx.execute(sql`SELECT (${categoryAccess.editable}) AS editable, (${categoryAccess.readable}) AS readable,
          s.id AS standard_id, s.level_ids
        FROM ql_categories c LEFT JOIN ql_standards s ON s.tenant_id = c.tenant_id AND s.category_id = c.id
        WHERE c.tenant_id = ${ctx.tenantId} AND c.code = ${row.categoryCode}`),
    )[0];
    if (!category?.readable) {
      fail('CATEGORY_NOT_FOUND');
      continue;
    }
    if (!category.editable) {
      fail('CATEGORY_READONLY');
      continue;
    }
    if (!category.standard_id) {
      fail('STANDARD_NOT_FOUND');
      continue;
    }
    const level = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT l.id FROM ql_levels l WHERE l.tenant_id = ${ctx.tenantId}
        AND l.code = ${row.levelCode}
        AND ${readableIn('l', 'level')}`),
    )[0];
    if (!level) {
      fail('LEVEL_NOT_FOUND');
      continue;
    }
    if (!(category.level_ids ?? []).includes(level.id)) {
      fail('LEVEL_NOT_IN_STANDARD');
      continue;
    }
    const target = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT t.id FROM ql_targets t WHERE t.tenant_id = ${ctx.tenantId}
        AND t.code = ${row.targetCode} AND ${readableIn('t', 'target')}`),
    )[0];
    if (!target) {
      fail('TARGET_NOT_FOUND');
      continue;
    }
    resolved.push({
      standardId: category.standard_id,
      categoryCode: row.categoryCode,
      levelId: level.id,
      targetId: target.id,
    });
  }
  return { resolved, receipts };
}

interface ImportCell {
  readonly standardId: string;
  readonly levelId: string;
  readonly targetId: string;
  readonly rows: number[];
}

/** 导入失败：整批回滚，逐行回执（receipts）；errors 供失败的任务日志生成逐行错误报告（DEC-199）。 */
function importRejected(receipts: ImportReceipt[]) {
  receipts.sort((a, b) => a.row - b.row);
  return new AppError('VALIDATION_FAILED', '导入数据有误，整批未导入', {
    reason: 'IMPORT_REJECTED',
    receipts,
    errors: receipts.map((receipt) => ({ row: receipt.row, details: { reason: receipt.reason } })),
  });
}

/**
 * 逐标准核对预期 revision（DEC-067，P2-06）：涉及的标准都要带，缺了 400；锁住后不符 409，整批不导入。
 * 锁序：标准（id 升序，FOR UPDATE）→ 指标（id 升序，FOR SHARE），与覆盖写入、冻结一致（P2-07）。
 */
async function lockImportTargets(
  tx: Tx,
  ctx: WriteContext,
  body: input.StandardImport,
  resolved: readonly (Resolved | undefined)[],
) {
  const expected = new Map(body.standards.map((item) => [item.categoryCode, item.revision]));
  const standards = new Map<string, number>();
  for (const item of resolved) {
    if (!item) continue;
    const revision = expected.get(item.categoryCode);
    if (revision === undefined) {
      throw new AppError('VALIDATION_FAILED', `请提供任职类别【${item.categoryCode}】的标准版本号`, {
        reason: 'STANDARD_REVISION_REQUIRED',
        categoryCode: item.categoryCode,
      });
    }
    standards.set(item.standardId, revision);
  }
  for (const standardId of [...standards.keys()].sort()) {
    const locked = rowsOf<{ revision: number }>(
      await tx.execute(sql`SELECT revision FROM ql_standards WHERE tenant_id = ${ctx.tenantId}
        AND id = ${standardId}::uuid FOR UPDATE`),
    )[0]!;
    if (locked.revision !== standards.get(standardId)) {
      throw new AppError('REVISION_CONFLICT', '任职资格标准已变更，请刷新后显式重提', {
        standardId,
        expected: standards.get(standardId),
        actual: locked.revision,
      });
    }
  }
  const targets = new Map<string, TargetRow & { enabled: boolean }>();
  for (const targetId of [...new Set(resolved.flatMap((item) => (item ? [item.targetId] : [])))].sort()) {
    const target = rowsOf<TargetRow & { enabled: boolean }>(
      await tx.execute(sql`SELECT id, is_common, description, eval_mode, grade_scheme_id, enabled FROM ql_targets
        WHERE tenant_id = ${ctx.tenantId} AND id = ${targetId}::uuid FOR SHARE`),
    )[0]!;
    targets.set(targetId, target);
  }
  return { standards: [...standards.keys()].sort(), targets };
}

/** 锁后按指标的当前状态复核（通用指标不能导入；新引用的指标须启用），把行归到格。 */
async function groupCells(
  tx: Tx,
  ctx: WriteContext,
  resolved: readonly (Resolved | undefined)[],
  targets: ReadonlyMap<string, TargetRow & { enabled: boolean }>,
  receipts: ImportReceipt[],
) {
  const cells = new Map<string, ImportCell>();
  const existing = new Map<string, string>();
  for (const [index, item] of resolved.entries()) {
    if (!item) continue;
    const target = targets.get(item.targetId)!;
    if (target.is_common) {
      receipts.push({ row: index + 1, reason: 'TARGET_COMMON' });
      continue;
    }
    const cellKey = `${item.standardId}|${key(item.levelId, item.targetId)}`;
    const cell = cells.get(cellKey) ?? {
      standardId: item.standardId,
      levelId: item.levelId,
      targetId: item.targetId,
      rows: [],
    };
    cell.rows.push(index);
    if (cell.rows.length > MAX_ABILITIES) receipts.push({ row: index + 1, reason: 'TOO_MANY_ABILITIES' });
    cells.set(cellKey, cell);
  }
  for (const [cellKey, cell] of cells) {
    const detail = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM ql_standard_details WHERE tenant_id = ${ctx.tenantId}
        AND standard_id = ${cell.standardId}::uuid AND level_id = ${cell.levelId}::uuid
          AND target_id = ${cell.targetId}::uuid`),
    )[0];
    if (detail) existing.set(cellKey, detail.id);
    else if (!targets.get(cell.targetId)!.enabled) receipts.push({ row: cell.rows[0]! + 1, reason: 'TARGET_DISABLED' });
  }
  return { cells, existing };
}

export async function importStandardDetails(tx: Tx, ctx: WriteContext, body: input.StandardImport) {
  const { resolved, receipts } = await resolveRows(tx, ctx, body.rows);
  if (receipts.length) throw importRejected(receipts);
  const { standards, targets } = await lockImportTargets(tx, ctx, body, resolved);
  const { cells, existing } = await groupCells(tx, ctx, resolved, targets, receipts);
  if (receipts.length) throw importRejected(receipts);
  const before = new Map<string, StandardView>();
  for (const standardId of standards) before.set(standardId, await reloadStandard(tx, ctx, standardId));
  let abilities = 0;
  for (const [cellKey, cell] of cells) {
    let detailId = existing.get(cellKey);
    if (!detailId) {
      detailId = rowsOf<{ id: string }>(
        await tx.execute(sql`INSERT INTO ql_standard_details (tenant_id, standard_id, level_id, target_id)
          VALUES (${ctx.tenantId}, ${cell.standardId}, ${cell.levelId}, ${cell.targetId}) RETURNING id`),
      )[0]!.id;
    }
    await tx.execute(
      sql`DELETE FROM ql_ability_details WHERE tenant_id = ${ctx.tenantId} AND detail_id = ${detailId}::uuid`,
    );
    const rows = cell.rows.map((index) => body.rows[index]!);
    await insertAbilities(
      tx,
      ctx,
      detailId,
      rows.map((row) => ({
        content: row.content,
        targetValue: row.targetValue,
        weight: row.weight,
        source: 'manual',
        sourceTargetId: null,
      })),
    );
    abilities += rows.length;
  }
  const orgs = new Map<string, string>();
  for (const standardId of standards) {
    await tx.execute(sql`UPDATE ql_standards SET revision = revision + 1, updated_at = ${ctx.now.toISOString()}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${standardId}::uuid`);
    const after = await reloadStandard(tx, ctx, standardId);
    orgs.set(standardId, after.ownerOrgId);
    await audit(tx, ctx, 'standard', 'import', standardId, {
      before: before.get(standardId),
      after,
      orgId: after.ownerOrgId,
    });
  }
  // 任务级日志（DEC-199，P2-12）：逐行成功，归属到所在标准的所属组织
  await recordImportLog(
    tx,
    { ...ctx, actorUserId: auditActor(ctx.userId) },
    codeOf('standard'),
    body.rows.map((row) => ({ status: 'updated', code: row.categoryCode })),
    resolved.map((item) => ({ objectId: item!.standardId, orgId: orgs.get(item!.standardId) ?? null })),
  );
  return { standards: standards.length, cells: cells.size, abilities, standardIds: standards };
}

// ── 发展通道（QL-R13） ───────────────────────────────────────

export interface ChannelView {
  readonly standardId: string;
  readonly revision: number;
  /** 纵向：本类别的级别按顺序号从低到高。 */
  readonly vertical: { levelId: string; displayOrder: number }[];
  readonly horizontal: { levelId: string; targetCategoryId: string; targetLevelId: string }[];
}

export async function loadChannels(tx: Tx, tenantId: string, standardId: string): Promise<ChannelView> {
  const standard = rowsOf<{ revision: number; level_ids: string[] }>(
    await tx.execute(
      sql`SELECT revision, level_ids FROM ql_standards WHERE tenant_id = ${tenantId}::uuid
        AND id = ${standardId}::uuid`,
    ),
  )[0]!;
  const vertical = rowsOf<{ id: string; display_order: number }>(
    await tx.execute(sql`SELECT id, display_order FROM ql_levels WHERE tenant_id = ${tenantId}::uuid
      AND id = ANY(${`{${standard.level_ids.join(',')}}`}::uuid[]) ORDER BY display_order`),
  );
  const horizontal = rowsOf<{ level_id: string; target_category_id: string; target_level_id: string }>(
    await tx.execute(sql`SELECT level_id, target_category_id, target_level_id FROM ql_development_channels
      WHERE tenant_id = ${tenantId}::uuid AND standard_id = ${standardId}::uuid ORDER BY ctid`),
  );
  return {
    standardId,
    revision: standard.revision,
    vertical: vertical.map((level) => ({ levelId: level.id, displayOrder: level.display_order })),
    horizontal: horizontal.map((h) => ({
      levelId: h.level_id,
      targetCategoryId: h.target_category_id,
      targetLevelId: h.target_level_id,
    })),
  };
}

/** 横向通道的保存提示（DEC-347② / DEC-348①：只提示、不拦截；DEC-349：不按权限裁剪）。 */
export interface ChannelWarning {
  readonly index: number;
  readonly reason: 'TARGET_STANDARD_MISSING' | 'TARGET_LEVEL_NOT_IN_STANDARD';
}

const channelKey = (c: { levelId: string; targetCategoryId: string; targetLevelId: string }) =>
  `${c.levelId}|${c.targetCategoryId}|${c.targetLevelId}`;

/**
 * 横向通道整组替换（随标准授权，If-Match 为标准的 revision）；目标类别 / 级别须可引用（新引用须启用）。
 * - 横向通往其他类别（QL-R13）：目标类别等于本标准的类别（同级或本类别其他级别）400 CHANNEL_SELF_LOOP（P2-09）；
 * - 目的地没有标准、或目标级别不在该标准的级别范围内：照常保存，返回里逐条提示（DEC-347② / DEC-348① / DEC-349）；
 * - 审计逐条路径写新增 / 删除（键即发展通道的字段，审计员按字段目录可见，P2-11；另带所属类别作范围锚点）。
 */
export async function putChannels(tx: Tx, ctx: WriteContext, standardId: string, body: input.ChannelsPut) {
  const row = await lockEditable(tx, ctx, 'standard', standardId);
  const before = await loadChannels(tx, ctx.tenantId, standardId);
  const known = new Set(before.horizontal.map((h) => `${h.targetCategoryId}|${h.targetLevelId}`));
  await tx.execute(
    sql`DELETE FROM ql_development_channels WHERE tenant_id = ${ctx.tenantId} AND standard_id = ${standardId}::uuid`,
  );
  const levels = row.level_ids as string[];
  const warnings: ChannelWarning[] = [];
  for (const [index, channel] of body.channels.entries()) {
    if (!levels.includes(channel.levelId)) {
      throw new AppError('VALIDATION_FAILED', '级别不在该标准的级别范围内', { reason: 'LEVEL_NOT_IN_STANDARD' });
    }
    if (channel.targetCategoryId === row.category_id) {
      throw new AppError('VALIDATION_FAILED', '横向发展通道须通往其他任职类别', { reason: 'CHANNEL_SELF_LOOP' });
    }
    const isNew = !known.has(`${channel.targetCategoryId}|${channel.targetLevelId}`);
    await referenced(tx, ctx, 'category', channel.targetCategoryId, isNew);
    await referenced(tx, ctx, 'level', channel.targetLevelId, isNew);
    const destination = rowsOf<{ level_ids: string[] }>(
      await tx.execute(sql`SELECT level_ids FROM ql_standards WHERE tenant_id = ${ctx.tenantId}
        AND category_id = ${channel.targetCategoryId}::uuid`),
    )[0];
    if (!destination) warnings.push({ index, reason: 'TARGET_STANDARD_MISSING' });
    else if (!destination.level_ids.includes(channel.targetLevelId)) {
      warnings.push({ index, reason: 'TARGET_LEVEL_NOT_IN_STANDARD' });
    }
    await tx.execute(sql`INSERT INTO ql_development_channels (tenant_id, standard_id, level_id,
      target_category_id, target_level_id)
      VALUES (${ctx.tenantId}, ${standardId}, ${channel.levelId}, ${channel.targetCategoryId}, ${channel.targetLevelId})
      ON CONFLICT DO NOTHING`);
  }
  await tx.execute(sql`UPDATE ql_standards SET revision = ${ctx.expectedRevision + 1},
    updated_at = ${ctx.now.toISOString()}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${standardId}::uuid`);
  const after = await loadChannels(tx, ctx.tenantId, standardId);
  const orgId = row.owner_org_id as string;
  // 所属类别不是通道字段（审计员按字段目录看不到），供审计范围与业务同锚在类别上（第 3 轮 R2-04）
  const categoryId = row.category_id as string;
  const was = new Set(before.horizontal.map(channelKey));
  const now = new Set(after.horizontal.map(channelKey));
  for (const channel of before.horizontal.filter((c) => !now.has(channelKey(c)))) {
    await audit(tx, ctx, 'developmentChannel', 'delete', standardId, {
      before: { standardId, categoryId, ...channel },
      after: null,
      orgId,
    });
  }
  for (const channel of after.horizontal.filter((c) => !was.has(channelKey(c)))) {
    await audit(tx, ctx, 'developmentChannel', 'create', standardId, {
      before: null,
      after: { standardId, categoryId, ...channel },
      orgId,
    });
  }
  return { ...after, warnings };
}
