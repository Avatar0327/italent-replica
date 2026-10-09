/**
 * 指标、等级方案、指标等级描述（docs/02_业务建模/23 §3.2 QL-R4～R7、§12；设计 §3.1）。
 * - 评分不选等级方案、评级必须选启用的等级方案（QL-R6）；被标准引用的指标不改评价方式 / 等级方案、不删除；
 * - 通用指标“覆盖写入”（DEC-334①，Q-T02-14 🟢）：非通用改通用、或通用指标改说明时，把指标说明写进所有引用该指标的
 *   标准（该格只留一条能力标准，来源 common_overwrite），须带确认（原站确认框原文）；改回非通用不改写各标准；
 *   覆盖会写到操作人范围外的标准（原站行为），逐个标准写审计；锁序先按 id 升序锁标准、再锁指标（§3.4）；
 * - 等级明细的增删改不写指标行：未手改的指标等级描述是明细描述的投影，手改的单独保存（QL-R7）；删除明细为软删。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { visible } from '../permission/module-route-access.js';
import { QUALIFICATION_LABELS } from './access.js';
import type * as input from './input.js';
import {
  gradeDetails,
  loadRow,
  view,
  withGradeDetails,
  withStandardParts,
  type GradeSchemeView,
  type OwnedView,
} from './read-model.js';
import {
  audit,
  autoCode,
  bumped,
  deleteChildren,
  guardUnique,
  lockEditable,
  ownerOf,
  referenced,
  rejectInUse,
  requireCodeAvailable,
  rowAccess,
  rowsOf,
  type WriteContext,
} from './store.js';
import { requireEditable, requireReadable } from './access.js';

/** 原站确认框原文（`23` §12 W-679～W-683）。 */
export const COMMON_OVERWRITE_MESSAGE =
  '保存指标将同步更新关联数据，是否确认保存？该指标为通用指标，保存后会将指标说明更新到使用该指标的任职资格标准中';

async function reloadTarget(tx: Tx, ctx: WriteContext, id: string) {
  return view<OwnedView & Record<string, unknown>>((await loadRow(tx, ctx.tenantId, 'target', id))!);
}

async function checkEvalMode(tx: Tx, ctx: WriteContext, mode: string, schemeId: string | null | undefined) {
  if (mode === 'score' && schemeId) {
    throw new AppError('VALIDATION_FAILED', '评分指标不能选择等级方案', { reason: 'GRADE_SCHEME_NOT_ALLOWED' });
  }
  if (mode === 'grade') {
    if (!schemeId)
      throw new AppError('VALIDATION_FAILED', '评级指标必须选择等级方案', { reason: 'GRADE_SCHEME_REQUIRED' });
    await referenced(tx, ctx, 'gradeScheme', schemeId);
  }
}

export async function createTarget(tx: Tx, ctx: WriteContext, body: input.TargetCreate) {
  await referenced(tx, ctx, 'targetType', body.typeId);
  await checkEvalMode(tx, ctx, body.evalMode, body.gradeSchemeId);
  const code = await autoCode(tx, ctx, 'target', body.code);
  await requireCodeAvailable(tx, ctx, 'target', code);
  const owner = await ownerOf(tx, ctx, 'target', body.ownerOrgId);
  const result = await guardUnique(() =>
    tx.execute(sql`INSERT INTO ql_targets (tenant_id, code, name, type_id, description, is_common, eval_mode,
      grade_scheme_id, display_order, enabled, public_down, owner_id, owner_org_id, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${code}, ${body.name}, ${body.typeId}, ${body.description ?? null},
        ${body.isCommon ?? false}, ${body.evalMode}, ${body.gradeSchemeId ?? null}, ${body.displayOrder ?? 0},
        ${body.enabled ?? true}, ${body.publicDown ?? false}, ${owner.ownerId}, ${owner.ownerOrgId},
        ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  const after = await reloadTarget(tx, ctx, id);
  await audit(tx, ctx, 'target', 'create', id, { before: null, after, orgId: owner.ownerOrgId });
  return after;
}

/** 引用该指标的标准（按 id 升序）。 */
async function referencingStandards(tx: Tx, tenantId: string, targetId: string, lock: boolean) {
  const result = await tx.execute(sql`SELECT s.id FROM ql_standards s WHERE s.tenant_id = ${tenantId}::uuid
    AND EXISTS (SELECT 1 FROM ql_standard_details d WHERE d.tenant_id = s.tenant_id AND d.standard_id = s.id
      AND d.target_id = ${targetId}::uuid)
    ORDER BY s.id ${lock ? sql`FOR UPDATE OF s` : sql``}`);
  return rowsOf<{ id: string }>(result).map((row) => row.id);
}

/** 某标准里引用该指标的格（格定位、指标值、权重与各条能力标准的全部值），作覆盖审计的前后快照（P2-13）。 */
async function cellsOf(tx: Tx, tenantId: string, standardId: string, targetId: string) {
  const [standard] = await withStandardParts(tx, tenantId, [(await loadRow(tx, tenantId, 'standard', standardId))!]);
  return standard!.details.filter((detail) => detail.targetId === targetId);
}

/**
 * 覆盖写入（DEC-334①）：引用该指标的每一格只留一条能力标准 = 指标说明（来源 common_overwrite）。
 * 调用方已按 id 升序锁住这些标准；每个标准 revision + 1，并写一条审计（同事务）。审计的键用标准的字段 `details`
 * （对得上字段目录，审计员才查得到，P2-11），前后值是受影响的格的完整快照（P2-13）。
 */
async function overwriteStandards(
  tx: Tx,
  ctx: WriteContext,
  targetId: string,
  description: string | null,
  ids: string[],
) {
  for (const standardId of ids) {
    const before = await cellsOf(tx, ctx.tenantId, standardId, targetId);
    await tx.execute(sql`DELETE FROM ql_ability_details a USING ql_standard_details d
      WHERE a.tenant_id = ${ctx.tenantId} AND d.tenant_id = a.tenant_id AND d.id = a.detail_id
        AND d.standard_id = ${standardId}::uuid AND d.target_id = ${targetId}::uuid`);
    await tx.execute(sql`INSERT INTO ql_ability_details (tenant_id, detail_id, content, display_order, source,
        source_target_id)
      SELECT ${ctx.tenantId}, d.id, ${description ?? ''}, 0, 'common_overwrite', ${targetId}::uuid
      FROM ql_standard_details d WHERE d.tenant_id = ${ctx.tenantId} AND d.standard_id = ${standardId}::uuid
        AND d.target_id = ${targetId}::uuid`);
    const standard = rowsOf<{ owner_org_id: string }>(
      await tx.execute(sql`UPDATE ql_standards SET revision = revision + 1, updated_at = ${ctx.now.toISOString()}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${standardId}::uuid RETURNING owner_org_id`),
    )[0]!;
    await audit(tx, ctx, 'standard', 'common-overwrite', standardId, {
      before: { details: before },
      after: { details: await cellsOf(tx, ctx.tenantId, standardId, targetId) },
      orgId: standard.owner_org_id,
    });
  }
}

export async function updateTarget(tx: Tx, ctx: WriteContext, id: string, body: input.TargetPatch) {
  // 先判可写（不可见 404 / 仅向下公开 403），不泄露存在与否；再按锁序：标准（id 升序）→ 指标
  requireEditable((await rowAccess(tx, ctx, ctx.scope, 'target', id)).access, 'target');
  const touchesCommon = body.isCommon !== undefined || body.description !== undefined;
  const locked = touchesCommon ? await referencingStandards(tx, ctx.tenantId, id, true) : [];
  const row = await lockEditable(tx, ctx, 'target', id);
  const wasCommon = row.is_common === true;
  const willBeCommon = body.isCommon ?? wasCommon;
  const describedChange = body.description !== undefined && body.description !== row.description;
  const overwrite = willBeCommon && (!wasCommon || describedChange);
  const standards = overwrite ? await referencingStandards(tx, ctx.tenantId, id, false) : [];
  if (standards.some((standardId) => !locked.includes(standardId))) {
    throw new AppError('CONFLICT', '引用该指标的标准刚刚变化，请重试', { reason: 'RETRY' });
  }
  if (overwrite && standards.length && body.confirmOverwrite !== true) {
    throw new AppError('CONFLICT', COMMON_OVERWRITE_MESSAGE, { reason: 'COMMON_OVERWRITE_CONFIRM' });
  }
  const mode = body.evalMode ?? (row.eval_mode as string);
  const scheme = body.gradeSchemeId !== undefined ? body.gradeSchemeId : (row.grade_scheme_id as string | null);
  if (body.evalMode !== undefined || body.gradeSchemeId !== undefined) {
    if (mode !== row.eval_mode || scheme !== row.grade_scheme_id) {
      await rejectInUse(tx, {
        sql: sql`SELECT 1 FROM ql_standard_details WHERE tenant_id = ${ctx.tenantId} AND target_id = ${id}::uuid`,
        message: '指标已被任职资格标准引用，不能修改评价方式或等级方案',
        reason: 'TARGET_IN_USE',
      });
      await checkEvalMode(tx, ctx, mode, scheme);
    }
  }
  if (body.code) await requireCodeAvailable(tx, ctx, 'target', body.code, id);
  const before = await reloadTarget(tx, ctx, id);
  const description = body.description !== undefined ? body.description : (row.description as string | null);
  const bump = bumped(ctx);
  await guardUnique(() =>
    tx.execute(sql`UPDATE ql_targets SET code = ${body.code ?? (row.code as string)},
      name = ${body.name ?? (row.name as string)},
      description = ${description}, is_common = ${willBeCommon}, eval_mode = ${mode}, grade_scheme_id = ${scheme},
      display_order = ${body.displayOrder ?? (row.display_order as number)},
        enabled = ${body.enabled ?? (row.enabled as boolean)},
      public_down = ${body.publicDown ?? (row.public_down as boolean)}, revision = ${bump.revision},
        updated_at = ${bump.updatedAt}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`),
  );
  if (overwrite) await overwriteStandards(tx, ctx, id, description, standards);
  const after = await reloadTarget(tx, ctx, id);
  await audit(tx, ctx, 'target', 'update', id, { before, after, orgId: row.owner_org_id as string });
  return after;
}

export async function deleteTarget(tx: Tx, ctx: WriteContext, id: string) {
  const row = await lockEditable(tx, ctx, 'target', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_standard_details WHERE tenant_id = ${ctx.tenantId} AND target_id = ${id}::uuid`,
    message: '指标已被任职资格标准引用，不能删除',
    reason: 'TARGET_IN_USE',
  });
  const before = await reloadTarget(tx, ctx, id);
  // 手改过的指标等级描述随指标级联删除：另需删除权，逐条写删除快照（DEC-019 / DEC-338 自检）
  const manual = await manualDescriptions(tx, ctx.tenantId, sql`g.target_id = ${id}::uuid`);
  await deleteChildren(
    tx,
    ctx,
    'targetGradeDescription',
    manual.map(({ orgId, ...item }) => ({ objectId: id, orgId, snapshot: item })),
  );
  await tx.execute(sql`DELETE FROM ql_targets WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'target', 'delete', id, { before, after: null, orgId: row.owner_org_id as string });
  return before;
}

/** 手改的指标等级描述（快照的键即 TargetGradeDescription 的字段）。 */
async function manualDescriptions(tx: Tx, tenantId: string, where: ReturnType<typeof sql>) {
  return rowsOf<{ target_id: string; grade_detail_id: string; description: string; owner_org_id: string }>(
    await tx.execute(sql`SELECT g.target_id, g.grade_detail_id, g.description, t.owner_org_id
      FROM ql_target_grade_descriptions g JOIN ql_targets t ON t.tenant_id = g.tenant_id AND t.id = g.target_id
      WHERE g.tenant_id = ${tenantId}::uuid AND ${where} ORDER BY g.target_id, g.grade_detail_id FOR UPDATE OF g`),
  ).map((row) => ({
    targetId: row.target_id,
    gradeDetailId: row.grade_detail_id,
    description: row.description,
    orgId: row.owner_org_id,
  }));
}

// ── 等级方案（字典） ─────────────────────────────────────────

async function reloadScheme(tx: Tx, ctx: WriteContext, id: string): Promise<GradeSchemeView> {
  return (await withGradeDetails(tx, ctx.tenantId, [(await loadRow(tx, ctx.tenantId, 'gradeScheme', id))!]))[0]!;
}

async function requireSchemeNameFree(tx: Tx, ctx: WriteContext, name: string, exceptId?: string) {
  const taken = rowsOf(
    await tx.execute(sql`SELECT 1 FROM ql_grade_schemes WHERE tenant_id = ${ctx.tenantId} AND name = ${name}
      AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)`),
  );
  if (taken.length) throw new AppError('CONFLICT', '等级方案名称重复，请重新输入', { reason: 'DUPLICATE' });
}

async function insertDetail(
  tx: Tx,
  ctx: WriteContext,
  schemeId: string,
  detail: input.GradeSchemeCreate['details'][number],
) {
  await tx.execute(sql`INSERT INTO ql_grade_details (tenant_id, scheme_id, name, grade, score, description)
    VALUES (${ctx.tenantId}, ${schemeId}, ${detail.name}, ${detail.grade}, ${detail.score ?? null},
      ${detail.description ?? null})`);
}

export async function createGradeScheme(tx: Tx, ctx: WriteContext, body: input.GradeSchemeCreate) {
  visible(ctx.scope, undefined, `${QUALIFICATION_LABELS.gradeScheme}不存在`);
  await requireSchemeNameFree(tx, ctx, body.name);
  if (body.details.some((detail) => detail.id)) throw new AppError('VALIDATION_FAILED', '新建等级方案的明细不能带 id');
  const result = await guardUnique(
    () =>
      tx.execute(sql`INSERT INTO ql_grade_schemes (tenant_id, name, description, enabled, created_by, created_at,
        updated_at) VALUES (${ctx.tenantId}, ${body.name}, ${body.description ?? null}, ${body.enabled ?? true},
        ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
    '等级方案名称',
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  for (const detail of body.details) await insertDetail(tx, ctx, id, detail);
  const after = await reloadScheme(tx, ctx, id);
  await audit(tx, ctx, 'gradeScheme', 'create', id, { before: null, after });
  return after;
}

/** 明细按 id 对应：带 id 的修改、不带 id 的新增、未列出的软删（QL-R7 联动由投影体现）。 */
export async function updateGradeScheme(tx: Tx, ctx: WriteContext, id: string, body: input.GradeSchemePatch) {
  const row = await lockEditable(tx, ctx, 'gradeScheme', id);
  if (body.name !== undefined) await requireSchemeNameFree(tx, ctx, body.name, id);
  const before = await reloadScheme(tx, ctx, id);
  const bump = bumped(ctx);
  await guardUnique(
    () =>
      tx.execute(sql`UPDATE ql_grade_schemes SET name = ${body.name ?? (row.name as string)},
        description = ${body.description !== undefined ? body.description : (row.description as string | null)},
        enabled = ${body.enabled ?? (row.enabled as boolean)}, revision = ${bump.revision},
        updated_at = ${bump.updatedAt}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`),
    '等级方案名称',
  );
  if (body.details) {
    const existing = new Set(before.details.map((detail) => detail.id));
    const kept = new Set<string>();
    for (const detail of body.details) {
      if (!detail.id) {
        await insertDetail(tx, ctx, id, detail);
        continue;
      }
      if (!existing.has(detail.id))
        throw new AppError('VALIDATION_FAILED', '等级明细不属于该等级方案', { reason: 'DETAIL_INVALID' });
      kept.add(detail.id);
      await tx.execute(sql`UPDATE ql_grade_details SET name = ${detail.name}, grade = ${detail.grade},
        score = ${detail.score ?? null}, description = ${detail.description ?? null}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${detail.id}::uuid`);
    }
    for (const detailId of existing) {
      if (kept.has(detailId)) continue;
      // 先锁明细再查引用（P2-07）：正在引用它的写入持 FOR SHARE，等其提交后再判断是否已被引用
      await tx.execute(sql`SELECT 1 FROM ql_grade_details WHERE tenant_id = ${ctx.tenantId} AND id = ${detailId}::uuid
        FOR UPDATE`);
      await rejectInUse(tx, {
        sql: sql`SELECT 1 FROM ql_ability_details WHERE tenant_id = ${ctx.tenantId}
          AND target_grade_id = ${detailId}::uuid`,
        message: '等级明细已被任职资格标准的目标等级引用，不能删除',
        reason: 'GRADE_DETAIL_IN_USE',
      });
      await tx.execute(sql`UPDATE ql_grade_details SET deleted_at = ${ctx.now.toISOString()}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${detailId}::uuid`);
    }
  }
  const after = await reloadScheme(tx, ctx, id);
  await audit(tx, ctx, 'gradeScheme', 'update', id, { before, after });
  return after;
}

/**
 * 删除等级方案：快照含全部明细（含软删的，随方案物理删除，P2-13）；改过方案的指标在旧方案明细上遗留的手改描述随之
 * 级联删除，另需指标等级描述的删除权并逐条写删除快照。
 */
export async function deleteGradeScheme(tx: Tx, ctx: WriteContext, id: string) {
  await lockEditable(tx, ctx, 'gradeScheme', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_targets WHERE tenant_id = ${ctx.tenantId} AND grade_scheme_id = ${id}::uuid`,
    message: '等级方案已被指标引用，不能删除',
    reason: 'GRADE_SCHEME_IN_USE',
  });
  const before = {
    ...(await reloadScheme(tx, ctx, id)),
    details: rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT id, name, grade, score, description, deleted_at FROM ql_grade_details
        WHERE tenant_id = ${ctx.tenantId} AND scheme_id = ${id}::uuid ORDER BY grade, ctid`),
    ).map((detail) => view<Record<string, unknown>>(detail)),
  };
  const leftovers = await manualDescriptions(
    tx,
    ctx.tenantId,
    sql`g.grade_detail_id IN (SELECT d.id FROM ql_grade_details d WHERE d.tenant_id = g.tenant_id
      AND d.scheme_id = ${id}::uuid)`,
  );
  await deleteChildren(
    tx,
    ctx,
    'targetGradeDescription',
    leftovers.map(({ orgId, ...item }) => ({ objectId: item.targetId, orgId, snapshot: item })),
  );
  await tx.execute(sql`DELETE FROM ql_grade_schemes WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'gradeScheme', 'delete', id, { before, after: null });
  return before;
}

// ── 指标等级描述 ─────────────────────────────────────────────

export interface GradeDescriptionView {
  readonly gradeDetailId: string;
  readonly name: string;
  readonly grade: number;
  readonly description: string | null;
  /** 是否手工改过（改过的单独保存，等级明细描述变化不再联动，QL-R7）。 */
  readonly modified: boolean;
}

/** 评级指标的等级描述：每条未删除的等级明细一条；未手改的取明细描述（投影）。评分指标为空。 */
export async function gradeDescriptions(tx: Tx, tenantId: string, targetId: string): Promise<GradeDescriptionView[]> {
  const target = rowsOf<{ eval_mode: string; grade_scheme_id: string | null }>(
    await tx.execute(sql`SELECT eval_mode, grade_scheme_id FROM ql_targets WHERE tenant_id = ${tenantId}::uuid
      AND id = ${targetId}::uuid`),
  )[0];
  if (!target?.grade_scheme_id) return [];
  const manual = rowsOf<{ grade_detail_id: string; description: string }>(
    await tx.execute(sql`SELECT grade_detail_id, description FROM ql_target_grade_descriptions
      WHERE tenant_id = ${tenantId}::uuid AND target_id = ${targetId}::uuid`),
  );
  return (await gradeDetails(tx, tenantId, target.grade_scheme_id)).map((detail) => {
    const own = manual.find((row) => row.grade_detail_id === detail.id);
    return {
      gradeDetailId: detail.id,
      name: detail.name,
      grade: detail.grade,
      description: own ? own.description : detail.description,
      modified: Boolean(own),
    };
  });
}

/** 手改一条等级描述：随指标授权（If-Match 为指标的 revision），指标 revision + 1。 */
export async function putGradeDescription(
  tx: Tx,
  ctx: WriteContext,
  targetId: string,
  detailId: string,
  description: string,
) {
  const row = await lockEditable(tx, ctx, 'target', targetId);
  // 锁住明细再判断（锁序 指标 → 等级明细，P2-07）：明细正被软删时等其提交，按提交后的状态判断
  const belongs = rowsOf<{ deleted_at: unknown }>(
    await tx.execute(sql`SELECT deleted_at FROM ql_grade_details WHERE tenant_id = ${ctx.tenantId}
      AND id = ${detailId}::uuid AND scheme_id = ${(row.grade_scheme_id as string | null) ?? null}::uuid
      FOR SHARE`),
  );
  if (!belongs.length || belongs[0]!.deleted_at !== null) throw new AppError('NOT_FOUND', '等级明细不存在');
  const before = await gradeDescriptions(tx, ctx.tenantId, targetId);
  await tx.execute(sql`INSERT INTO ql_target_grade_descriptions (tenant_id, target_id, grade_detail_id, description,
      updated_by, updated_at)
    VALUES (${ctx.tenantId}, ${targetId}, ${detailId}, ${description}, ${ctx.userId}, ${ctx.now.toISOString()})
    ON CONFLICT (tenant_id, target_id, grade_detail_id)
    DO UPDATE SET description = EXCLUDED.description, updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at`);
  await tx.execute(sql`UPDATE ql_targets SET revision = ${ctx.expectedRevision + 1},
    updated_at = ${ctx.now.toISOString()}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${targetId}::uuid`);
  const after = await gradeDescriptions(tx, ctx.tenantId, targetId);
  const old = before.find((item) => item.gradeDetailId === detailId)!;
  // 首次手改时 before 是等级明细描述的投影：标出来源方案，审计查询按查看人对该方案的读取范围与明细字段权裁剪（P2-05）
  await audit(tx, ctx, 'targetGradeDescription', 'update', targetId, {
    before: {
      targetId,
      gradeDetailId: detailId,
      description: old.description,
      ...(old.modified ? {} : { projected: true, gradeSchemeId: row.grade_scheme_id as string }),
    },
    after: { targetId, gradeDetailId: detailId, description },
    orgId: row.owner_org_id as string,
  });
  return {
    id: targetId,
    revision: ctx.expectedRevision + 1,
    gradeSchemeId: row.grade_scheme_id as string,
    items: after,
  };
}

export { requireReadable };
