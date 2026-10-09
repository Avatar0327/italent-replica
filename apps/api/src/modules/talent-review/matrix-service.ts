/**
 * 九宫格的读写（设计 §2.2 matrices / position_fields / axis_levels / cells / ratio_rule_*；TR-R31～R35；D-20）。
 * 九宫格是一个聚合：位置字段占用、轴分段、格子随它整体读写，比例规则组有稳定 id（项目按它引用）但写入共用九宫格的 revision
 * （每次规则组写入 revision +1，If-Match 是九宫格的 revision）。在 config-kit.ts 的通用骨架之上加九宫格自己的规则：
 * - 位置字段租户内唯一（库唯一约束兜底，并发时恰一个成功），保存命令恰两行（before / after），只能是“位置”分组的数值字段；
 * - 轴 / 分段 / 格子整组校验（领域层 checkAxisLevels / checkCells）；引用的字段须当前操作人在字段目录范围内可见，
 *   看不到与不存在同一个 404（不暴露隐藏字段的存在与类型）；新引用已停用的字段 400；
 * - 名称、编码、位置字段占用都是租户唯一：只有创建人范围的人改名、改位置字段一律 403（判定在查重之前，不暴露隐藏记录）；
 * - 被规则引用的格子不能删（409）；预置九宫格不能删除（可停用）；字段被九宫格引用时不能删除（引用守卫）。
 */
import {
  and,
  eq,
  inArray,
  pgErrorCode,
  sql,
  talentReviewFieldOptions as O,
  talentReviewFields as F,
  talentReviewMatrices as M,
  talentReviewMatrixAxisLevels as L,
  talentReviewMatrixCells as C,
  talentReviewMatrixPositionFields as P,
  talentReviewRatioRuleCells as RC,
  talentReviewRatioRuleGroups as G,
  talentReviewRatioRules as R,
  type Tx,
} from '@italent/db';
import {
  checkAxisLevels,
  checkCells,
  checkRatioRule,
  MATRIX_AXES,
  MATRIX_AXIS_FIELD_KINDS,
  MATRIX_POSITION_FIELD_GROUP,
  type MatrixViolation,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { notFoundMessage, requireConfigCreatable, requireConfigVisible, type ModuleScope } from './access.js';
import {
  auditConfig,
  createConfig,
  deleteConfig,
  lockConfigRow,
  registerConfigReferenceGuard,
  requireSeeAllToRename,
  uniqueOr,
  type WriteContext,
} from './config-kit.js';
import type {
  AxisLevelBody,
  CellBody,
  MatrixCreate,
  MatrixPatch,
  PositionFieldBody,
  RatioGroupCreate,
  RatioGroupPatch,
} from './matrix-input.js';
import { loadMatrixView, MATRIX, type MatrixView } from './matrix-view.js';

export interface MatrixWriteContext extends WriteContext {
  /** 引用字段目录对象所需的范围；请求不带任何字段引用时为空。 */
  readonly fieldScope?: ModuleScope;
  /**
   * 请求体里显式提交的字段引用（轴、第三维度、位置字段）。首次执行在业务事务内、任何写入之前按当前字段目录范围复核
   * 全部这些引用（原样带上的已有引用也算），拒绝时整个命令回滚：业务、revision、台账、审计都不留痕。
   */
  readonly references?: readonly string[];
}

// ---- 引用字段：校验与可见性 --------------------------------------------------------------------------------------

interface FieldFacts {
  readonly id: string;
  readonly kind: string;
  readonly group: string;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly optionValues: Set<string>;
}

/**
 * 读引用字段的属性。写入路径（lock = true）对这些字段行加 FOR KEY SHARE：与字段删除（行 FOR UPDATE）互斥，
 * 字段先被删就读不到（404），读到了就保证提交前不被删（删除方随后看到占用 → 409 FIELD_IN_USE），不会在插入时撞外键 500。
 */
async function loadFieldFacts(tx: Tx, tenantId: string, ids: string[], lock = false): Promise<Map<string, FieldFacts>> {
  if (ids.length === 0) return new Map();
  const query = tx
    .select({ id: F.id, kind: F.kind, group: F.group, enabled: F.enabled, createdBy: F.createdBy })
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, ids)));
  const fields = await (lock ? query.for('key share') : query);
  const options = await tx
    .select({ fieldId: O.fieldId, value: O.value })
    .from(O)
    .where(and(eq(O.tenantId, tenantId), inArray(O.fieldId, ids)));
  return new Map(
    fields.map((f) => [
      f.id,
      { ...f, optionValues: new Set(options.filter((o) => o.fieldId === f.id).map((o) => o.value)) },
    ]),
  );
}

const invalid = (v: MatrixViolation) => new AppError('VALIDATION_FAILED', v.message, { reason: v.reason });
const reject = (reason: string, message: string) => invalid({ reason, message });

/** 新引用的字段：不存在与不在字段目录范围内同一个 404；任何属性判断都在可见性之后。 */
function requireVisibleRefs(scope: ModuleScope | undefined, facts: Map<string, FieldFacts>, ids: readonly string[]) {
  for (const id of ids) {
    const field = facts.get(id);
    if (!field) throw new AppError('NOT_FOUND', notFoundMessage('field'));
    if (!scope) throw new Error('引用字段缺少字段目录范围');
    requireConfigVisible(scope, 'field', field.createdBy);
  }
}

/**
 * 命令重放的授权复核（与业务校验分开）：请求里引用的字段在**当前**字段目录范围内仍须可见——幂等重放不再执行命令，
 * 撤销范围后原命令重放同样 404（AGENTS §10）。
 */
export async function requireReferencesVisible(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  scope: ModuleScope,
): Promise<void> {
  const unique = [...new Set(ids)];
  requireVisibleRefs(scope, await loadFieldFacts(tx, tenantId, unique), unique);
}

interface Shape {
  readonly xFieldId: string;
  readonly yFieldId: string;
  readonly zFieldId: string | null;
  readonly positionFields: readonly PositionFieldBody[];
  readonly axisLevels: readonly AxisLevelBody[];
  readonly cells: readonly CellBody[];
}
/** 九宫格当前持有的字段引用（轴、第三维度、位置字段）。 */
const heldRefs = (view: MatrixView): Pick<Shape, 'xFieldId' | 'yFieldId' | 'zFieldId' | 'positionFields'> => ({
  xFieldId: view.xFieldId as string,
  yFieldId: view.yFieldId as string,
  zFieldId: view.zFieldId as string | null,
  positionFields: view.positionFields as PositionFieldBody[],
});
const refIds = (shape: Pick<Shape, 'xFieldId' | 'yFieldId' | 'zFieldId' | 'positionFields'>): string[] => [
  ...new Set(
    [shape.xFieldId, shape.yFieldId, shape.zFieldId, ...shape.positionFields.map((p) => p.fieldId)].filter(
      (id): id is string => id !== null,
    ),
  ),
];

/** 请求结构自洽的部分（不读库）：X ≠ Y，位置字段恰两行 before / after。 */
function checkStructure(shape: Shape) {
  if (shape.xFieldId === shape.yFieldId) throw reject('MATRIX_AXIS_SAME_FIELD', 'X 轴与 Y 轴不能是同一个字段');
  const roles = new Set(shape.positionFields.map((p) => p.role));
  if (shape.positionFields.length !== 2 || roles.size !== 2) {
    throw reject('MATRIX_POSITION_FIELDS_INCOMPLETE', '位置字段须恰好两行：校准前与校准后各一个');
  }
}

/** 引用字段的属性与分段 / 格子（读库后）：轴字段单选或数值，位置字段是“位置”分组的数值字段，新引用的字段须已启用。 */
function checkAgainstFields(shape: Shape, facts: Map<string, FieldFacts>, added: readonly string[]) {
  const axisFields = { x: facts.get(shape.xFieldId)!, y: facts.get(shape.yFieldId)! };
  for (const field of Object.values(axisFields)) {
    if (!(MATRIX_AXIS_FIELD_KINDS as readonly string[]).includes(field.kind)) {
      throw reject('MATRIX_AXIS_FIELD_KIND', '九宫格的轴只能是单选或数值字段');
    }
  }
  for (const { fieldId } of shape.positionFields) {
    const field = facts.get(fieldId)!;
    if (field.kind !== 'number' || field.group !== MATRIX_POSITION_FIELD_GROUP) {
      throw reject('MATRIX_POSITION_FIELD_KIND', '位置字段必须是“位置”分组的数值字段');
    }
  }
  if (added.some((id) => !facts.get(id)!.enabled)) {
    throw reject('MATRIX_FIELD_DISABLED', '该字段已停用，不能新引用');
  }
  for (const axis of MATRIX_AXES) {
    const bad = checkAxisLevels(axis, axisFields[axis], shape.axisLevels);
    if (bad) throw invalid(bad);
  }
  const count = (axis: 'x' | 'y') => shape.axisLevels.filter((l) => l.axis === axis).length;
  const bad = checkCells(count('x'), count('y'), shape.cells);
  if (bad) throw invalid(bad);
}

/** 读库校验：先判可见性（新引用），再判属性。 */
async function validateShape(tx: Tx, ctx: MatrixWriteContext, shape: Shape, current: readonly string[]) {
  checkStructure(shape);
  const ids = refIds(shape);
  const added = ids.filter((id) => !current.includes(id));
  const facts = await loadFieldFacts(tx, ctx.tenantId, ids, true);
  requireVisibleRefs(ctx.fieldScope, facts, added);
  checkAgainstFields(shape, facts, added);
}

/**
 * 位置字段占用的锁协议（PR #182 第 1 / 2 轮死锁；所有写位置字段占用行的入口都遵守）：
 * 1. 至多先取**一个**九宫格行锁（修改 / 删除；新建与预置补装没有）；
 * 2. 然后在本事务**任何写入之前**，把本事务涉及的**全部**位置字段（旧占用 ∪ 新占用；补装 = 所有待装预置的位置字段）
 *    合在一起按字段 id 排序，**一次**取齐占用锁（pg_advisory_xact_lock，事务结束释放）——不分批、不在写入之后补取；
 * 3. 之后才读引用字段（FOR KEY SHARE）、写九宫格行、删旧占用、插新占用。
 * 取锁之后不会再等任何九宫格行锁或占用锁，所以占用锁的等待只会排队、不会成环；随后由唯一约束给出受控的占用冲突（409）。
 * 入口：新建（createMatrix）、修改位置字段（updateMatrix）、删除（deleteMatrix）、预置补装（matrix-presets.ts）。
 * 字段停用 / 删除只取字段行锁，不取九宫格行锁与占用锁；写入方对引用字段只取 KEY SHARE，删除方等写入方结束后由引用守卫判定。
 * 补装里因依赖不可用而跳过的预置，其字段锁留到事务结束：补装取锁后不再等待其他锁，多持有只会让并发写入方多排一会儿，不会成环。
 * 补装事务在这一步之前只插入新的预置行（预置字段等），并发事务看不到未提交的新行，不会等它们。
 */
export async function lockPositionFields(tx: Tx, tenantId: string, fieldIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(fieldIds)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${positionLockKey(tenantId, id)})`);
  }
}

/** 位置字段占用锁的键（租户 + 字段）；并发测试的屏障用同一个键。 */
export const positionLockKey = (tenantId: string, fieldId: string) =>
  sql`hashtextextended(${tenantId}::text || ':matrix-position:' || ${fieldId}::text, 0)`;

// ---- 子数据写入 ----------------------------------------------------------------------------------------------------

async function insertPositions(tx: Tx, ctx: MatrixWriteContext, matrixId: string, rows: readonly PositionFieldBody[]) {
  try {
    await tx
      .insert(P)
      .values(rows.map((p) => ({ tenantId: ctx.tenantId, matrixId, fieldId: p.fieldId, role: p.role })));
  } catch (error) {
    // 位置字段租户内唯一：并发占用同一字段时库唯一约束只放行一个
    if (pgErrorCode(error) === '23505') {
      throw new AppError('CONFLICT', '该字段已被位置字段占用，不能重复使用', {
        reason: 'MATRIX_POSITION_FIELD_IN_USE',
      });
    }
    throw error;
  }
}

const levelRows = (ctx: MatrixWriteContext, matrixId: string, levels: readonly AxisLevelBody[]) =>
  levels.map((l) => ({
    tenantId: ctx.tenantId,
    matrixId,
    axis: l.axis,
    levelNo: l.levelNo,
    name: l.name,
    optionValues: l.optionValues,
    lowerBound: l.lowerBound === null ? null : String(l.lowerBound),
  }));

const cellRow = (ctx: MatrixWriteContext, matrixId: string, c: CellBody) => ({
  tenantId: ctx.tenantId,
  matrixId,
  cellNo: c.cellNo,
  xLevelNo: c.xLevelNo,
  yLevelNo: c.yLevelNo,
  name: c.name,
  color: c.color,
  countsGreen: c.countsGreen,
});

/** 轴分段整组重写（无外部引用）；格子按格子号原位更新——被比例规则引用的格子不能删。 */
async function syncLevelsAndCells(
  tx: Tx,
  ctx: MatrixWriteContext,
  matrixId: string,
  levels: readonly AxisLevelBody[],
  cells: readonly CellBody[],
) {
  const scope = and(eq(C.tenantId, ctx.tenantId), eq(C.matrixId, matrixId));
  const existing = new Set((await tx.select({ cellNo: C.cellNo }).from(C).where(scope)).map((c) => c.cellNo));
  const keep = new Set(cells.map((c) => c.cellNo));
  const gone = [...existing].filter((cellNo) => !keep.has(cellNo));
  try {
    if (gone.length > 0) await tx.delete(C).where(and(scope, inArray(C.cellNo, gone)));
  } catch (error) {
    if (pgErrorCode(error) === '23503') {
      throw new AppError('CONFLICT', '格子已被比例规则引用，不能删除', { reason: 'MATRIX_CELL_IN_USE' });
    }
    throw error;
  }
  await tx.delete(L).where(and(eq(L.tenantId, ctx.tenantId), eq(L.matrixId, matrixId)));
  await tx.insert(L).values(levelRows(ctx, matrixId, levels));
  for (const cell of cells) {
    if (!existing.has(cell.cellNo)) {
      await tx.insert(C).values(cellRow(ctx, matrixId, cell));
      continue;
    }
    const { tenantId: _tenant, matrixId: _matrix, cellNo, ...columns } = cellRow(ctx, matrixId, cell);
    await tx
      .update(C)
      .set(columns)
      .where(and(scope, eq(C.cellNo, cellNo)));
  }
}

// ---- 九宫格的新建 / 修改 / 删除 -------------------------------------------------------------------------------------

export async function createMatrix(tx: Tx, ctx: MatrixWriteContext, input: MatrixCreate): Promise<MatrixView> {
  const { positionFields, axisLevels, cells, ...columns } = input;
  // 新建范围先于一切读取：范围为空的人对任何字段引用都得到同一个结果
  requireConfigCreatable(ctx.scope, 'matrix');
  const shape: Shape = { ...input, zFieldId: input.zFieldId ?? null };
  await lockPositionFields(
    tx,
    ctx.tenantId,
    positionFields.map((p) => p.fieldId),
  );
  await validateShape(tx, ctx, shape, []);
  return createConfig(tx, MATRIX, ctx, columns, async (id) => {
    await insertPositions(tx, ctx, id, positionFields);
    await tx.insert(L).values(levelRows(ctx, id, axisLevels));
    await tx.insert(C).values(cells.map((cell) => cellRow(ctx, id, cell)));
  });
}

const samePositions = (a: readonly PositionFieldBody[], b: readonly PositionFieldBody[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.role === x.role && y.fieldId === x.fieldId));

export async function updateMatrix(
  tx: Tx,
  ctx: MatrixWriteContext,
  id: string,
  patch: MatrixPatch,
): Promise<MatrixView> {
  await lockConfigRow(tx, MATRIX, ctx, id);
  const before = (await loadMatrixView(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const { positionFields, axisLevels, cells, ...columns } = patch;
  const repoint =
    positionFields !== undefined && !samePositions(before.positionFields as PositionFieldBody[], positionFields);
  // 位置字段占用租户唯一，改成他人隐藏九宫格占用的字段会撞唯一约束；判定在任何查重之前，目标是否被占用都同一个结果
  if (repoint && !ctx.scope.all) {
    throw new AppError('FORBIDDEN', '只有能查看全部的人可以修改位置字段', {
      reason: 'MATRIX_POSITION_REQUIRES_SEE_ALL',
    });
  }
  // 显式提交的引用（含原样带上的已有引用）在任何写入之前按当前字段目录范围复核
  if (ctx.references && ctx.references.length > 0) {
    if (!ctx.fieldScope) throw new Error('引用字段缺少字段目录范围');
    await requireReferencesVisible(tx, ctx.tenantId, ctx.references, ctx.fieldScope);
  }
  if (repoint) {
    await lockPositionFields(tx, ctx.tenantId, [
      ...before.positionFields.map((p) => p.fieldId),
      ...positionFields.map((p) => p.fieldId),
    ]);
  }
  const held = heldRefs(before);
  const shape: Shape = {
    xFieldId: patch.xFieldId ?? held.xFieldId,
    yFieldId: patch.yFieldId ?? held.yFieldId,
    zFieldId: patch.zFieldId === undefined ? held.zFieldId : patch.zFieldId,
    positionFields: positionFields ?? held.positionFields,
    axisLevels: axisLevels ?? (before.axisLevels as AxisLevelBody[]),
    cells: cells ?? (before.cells as CellBody[]),
  };
  const touchesShape = [patch.xFieldId, patch.yFieldId, patch.zFieldId, positionFields, axisLevels].some(
    (value) => value !== undefined,
  );
  // 启用前再校验一次（P3-01）
  if (touchesShape || patch.enabled === true) {
    const current = refIds(heldRefs(before));
    await validateShape(tx, ctx, shape, current);
  }
  await uniqueOr(MATRIX.duplicate, MATRIX.label, () =>
    tx
      .update(M)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(M.tenantId, ctx.tenantId), eq(M.id, id))),
  );
  if (repoint) {
    await tx.delete(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.matrixId, id)));
    await insertPositions(tx, ctx, id, positionFields);
  }
  if (axisLevels !== undefined && cells !== undefined) await syncLevelsAndCells(tx, ctx, id, axisLevels, cells);
  const after = (await loadMatrixView(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'matrix', 'update', id, before, after);
  return after;
}

export function deleteMatrix(tx: Tx, ctx: MatrixWriteContext, id: string): Promise<MatrixView> {
  return deleteConfig(tx, MATRIX, ctx, id, async (before) => {
    if (before.preset) throw new AppError('CONFLICT', '预置九宫格不能删除，可以停用', { reason: 'MATRIX_PRESET' });
    // 删除会释放位置字段占用（级联删占用行）：同样在写入之前取这批字段的占用锁（锁协议见 lockPositionFields）
    await lockPositionFields(
      tx,
      ctx.tenantId,
      (before.positionFields as PositionFieldBody[]).map((p) => p.fieldId),
    );
    // 规则对格子的引用是 NO ACTION，同一条语句里级联的先后不定：先删规则组（级联规则与格子集合），再删九宫格。
    // 之后被引用守卫拒绝时整个命令事务回滚，规则组不会丢
    await tx.delete(G).where(and(eq(G.tenantId, ctx.tenantId), eq(G.matrixId, id)));
  });
}

// ---- 比例规则组 ----------------------------------------------------------------------------------------------------

export type RatioGroupReferenceGuard = (tx: Tx, tenantId: string, groupId: string) => Promise<string | null>;
const groupGuards: RatioGroupReferenceGuard[] = [];
/** 引用方（B7 项目的九宫格 + 规则组）加载时登记；删除规则组时同事务逐个询问，任一引用即 409 RATIO_GROUP_IN_USE。 */
export function registerRatioGroupReferenceGuard(guard: RatioGroupReferenceGuard): void {
  if (!groupGuards.includes(guard)) groupGuards.push(guard);
}

function checkRules(rules: RatioGroupCreate['rules'], view: MatrixView) {
  const cellNos = new Set(view.cells.map((c) => c.cellNo));
  for (const rule of rules) {
    const bad = checkRatioRule(rule, cellNos);
    if (bad) throw invalid(bad);
  }
}

async function insertRules(
  tx: Tx,
  ctx: MatrixWriteContext,
  matrixId: string,
  groupId: string,
  rules: RatioGroupCreate['rules'],
) {
  for (const [index, rule] of rules.entries()) {
    const [created] = await tx
      .insert(R)
      .values({
        tenantId: ctx.tenantId,
        groupId,
        operator: rule.operator,
        pctLow: String(rule.pctLow),
        pctHigh: rule.pctHigh === undefined ? null : String(rule.pctHigh),
        sortNo: index + 1,
      })
      .returning({ id: R.id });
    await tx
      .insert(RC)
      .values(rule.cellNos.map((cellNo) => ({ tenantId: ctx.tenantId, ruleId: created!.id, matrixId, cellNo })));
  }
}

const duplicateGroup = (error: unknown) => {
  if (pgErrorCode(error) === '23505') {
    return new AppError('CONFLICT', '规则组名称重复', { reason: 'RATIO_GROUP_DUPLICATE' });
  }
  return error;
};

/** 规则组写入的收尾：九宫格 revision +1，按聚合留字段级审计（变更记在 ratioGroups 字段上）。 */
async function finishGroupWrite(tx: Tx, ctx: MatrixWriteContext, id: string, before: MatrixView) {
  await tx
    .update(M)
    .set({ revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
    .where(and(eq(M.tenantId, ctx.tenantId), eq(M.id, id)));
  const after = (await loadMatrixView(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'matrix', 'update', id, before, after);
  return after;
}

const clearDefault = (tx: Tx, ctx: MatrixWriteContext, matrixId: string) =>
  tx
    .update(G)
    .set({ isDefault: false })
    .where(and(eq(G.tenantId, ctx.tenantId), eq(G.matrixId, matrixId), eq(G.isDefault, true)));

export async function createRatioGroup(tx: Tx, ctx: MatrixWriteContext, id: string, input: RatioGroupCreate) {
  await lockConfigRow(tx, MATRIX, ctx, id);
  const before = (await loadMatrixView(tx, ctx.tenantId, id))!;
  checkRules(input.rules, before);
  if (input.isDefault) await clearDefault(tx, ctx, id);
  // 取最大序号 + 1：删除过的组留下的空档不会让新组与现有组同序号
  const [last] = await tx
    .select({ top: sql<number>`coalesce(max(${G.sortNo}), 0)::int` })
    .from(G)
    .where(and(eq(G.tenantId, ctx.tenantId), eq(G.matrixId, id)));
  const sortNo = (last?.top ?? 0) + 1;
  let groupId: string;
  try {
    const [created] = await tx
      .insert(G)
      .values({
        tenantId: ctx.tenantId,
        matrixId: id,
        name: input.name,
        isDefault: input.isDefault ?? false,
        controlScope: input.controlScope,
        controlMode: input.controlMode,
        minPopulation: input.minPopulation ?? 0,
        sortNo,
        createdAt: ctx.now,
      })
      .returning({ id: G.id });
    groupId = created!.id;
  } catch (error) {
    throw duplicateGroup(error);
  }
  await insertRules(tx, ctx, id, groupId, input.rules);
  return finishGroupWrite(tx, ctx, id, before);
}

async function requireGroup(tx: Tx, ctx: MatrixWriteContext, matrixId: string, groupId: string) {
  const [group] = await tx
    .select({ id: G.id })
    .from(G)
    .where(and(eq(G.tenantId, ctx.tenantId), eq(G.matrixId, matrixId), eq(G.id, groupId)))
    .for('update');
  if (!group) throw new AppError('NOT_FOUND', '比例规则组不存在');
}

export async function updateRatioGroup(
  tx: Tx,
  ctx: MatrixWriteContext,
  id: string,
  groupId: string,
  patch: RatioGroupPatch,
) {
  await lockConfigRow(tx, MATRIX, ctx, id);
  await requireGroup(tx, ctx, id, groupId);
  const before = (await loadMatrixView(tx, ctx.tenantId, id))!;
  if (patch.rules) checkRules(patch.rules, before);
  if (patch.isDefault) await clearDefault(tx, ctx, id);
  const { rules, ...columns } = patch;
  try {
    if (Object.keys(columns).length > 0) {
      await tx
        .update(G)
        .set(columns)
        .where(and(eq(G.tenantId, ctx.tenantId), eq(G.id, groupId)));
    }
  } catch (error) {
    throw duplicateGroup(error);
  }
  if (rules) {
    await tx.delete(R).where(and(eq(R.tenantId, ctx.tenantId), eq(R.groupId, groupId)));
    await insertRules(tx, ctx, id, groupId, rules);
  }
  return finishGroupWrite(tx, ctx, id, before);
}

export async function deleteRatioGroup(tx: Tx, ctx: MatrixWriteContext, id: string, groupId: string) {
  await lockConfigRow(tx, MATRIX, ctx, id);
  await requireGroup(tx, ctx, id, groupId);
  const before = (await loadMatrixView(tx, ctx.tenantId, id))!;
  for (const guard of groupGuards) {
    const referrer = await guard(tx, ctx.tenantId, groupId);
    if (referrer) {
      throw new AppError('CONFLICT', '比例规则组已被引用，不能删除', { reason: 'RATIO_GROUP_IN_USE', referrer });
    }
  }
  await tx.delete(G).where(and(eq(G.tenantId, ctx.tenantId), eq(G.id, groupId)));
  return finishGroupWrite(tx, ctx, id, before);
}

// ---- 字段删除守卫：被九宫格的轴 / 位置字段引用的字段不能删 -----------------------------------------------------------

registerConfigReferenceGuard('field', async (tx, tenantId, fieldId) => {
  const axis = await tx
    .select({ id: M.id })
    .from(M)
    .where(and(eq(M.tenantId, tenantId), sql`${fieldId}::uuid IN (${M.xFieldId}, ${M.yFieldId}, ${M.zFieldId})`))
    .limit(1);
  if (axis.length > 0) return 'MATRIX';
  const position = await tx
    .select({ id: P.id })
    .from(P)
    .where(and(eq(P.tenantId, tenantId), eq(P.fieldId, fieldId)))
    .limit(1);
  return position.length > 0 ? 'MATRIX' : null;
});

/**
 * 预置补装用：依赖字段是否可用——与普通创建同一套属性校验（轴字段类型与分段、位置字段是“位置”分组的数值字段、已启用），
 * 另查位置字段是否已被其他九宫格占用。返回原因码；可用返回 null。租户定制过的字段按定制后的状态判定，不覆盖。
 */
export async function presetShapeProblem(tx: Tx, tenantId: string, shape: Shape): Promise<string | null> {
  const ids = refIds(shape);
  const facts = await loadFieldFacts(tx, tenantId, ids, true);
  if (ids.some((id) => !facts.has(id))) return 'MATRIX_FIELD_MISSING';
  try {
    checkAgainstFields(shape, facts, ids);
  } catch (error) {
    if (error instanceof AppError) return (error.details as { reason: string }).reason;
    throw error;
  }
  const occupied = await tx
    .select({ id: P.id })
    .from(P)
    .where(
      and(
        eq(P.tenantId, tenantId),
        inArray(
          P.fieldId,
          shape.positionFields.map((p) => p.fieldId),
        ),
      ),
    )
    .limit(1);
  return occupied.length > 0 ? 'MATRIX_POSITION_FIELD_IN_USE' : null;
}

export type { Shape as MatrixShape };
