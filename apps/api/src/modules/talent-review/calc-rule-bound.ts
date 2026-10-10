/**
 * 计算规则的保存（F-082，开关打开时；契约 §1.5、§1.6、§2、§3.3、§5.3）。公式按名称输入，服务端绑定成字段 ID：
 * 库里存规范文本（句柄）+ 引用表（kind = 'bound'），审计存写入时刻的名称（fieldNames）与引用 ID（refFieldIds）。
 *
 * 保存顺序（契约 §2，锁序 R < F < V < I，§3.4）：规则行已由调用方锁住（新建无此步）→ 第一遍绑定（读已提交数据）→
 * 对 目标 ∪ 引用 排序后一次性字段行 FOR SHARE → 字段目录版本行 FOR SHARE → 第二遍绑定，要求与第一遍逐处相同
 * （否则 409 CALC_FIELD_CHANGED）→ 写项目行与引用表 → 审计（命令台账由命令层同事务写）。
 * 原样保留（契约 §1.6）：提交的公式与绑定逐字等于该查看人当前的渲染 → 视为未修改，保留已存规范文本与引用，不重新绑定。
 */
import {
  and,
  eq,
  inArray,
  talentReviewCalcItemRefs as R,
  talentReviewCalcRuleItems as I,
  talentReviewCalcRules as K,
  type Tx,
} from '@italent/db';
import {
  analyzeBoundItems,
  type BindFailure,
  bindFormula,
  type BoundCalcItem,
  type CalcAnalysis,
  type CalcHints,
  checkInputLimits,
  FORMULA_CONTEXT_FIELDS,
  formulaPath,
  HIDDEN_FIELD_PLACEHOLDER,
  formulaReferences,
  type FormulaField,
  type FormulaBindingState,
  parseFieldHandle,
  renderFormula,
  targetNotAllowed,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { notFoundMessage, requireConfigCreatable } from './access.js';
import type { BoundCalcItemBody, BoundCalcRuleCreate, BoundCalcRulePatch } from './calc-rule-input.js';
import { type CatalogAccess, type CatalogRow, loadFullCatalog, lockFields, visibleOf } from './calc-rule-catalog.js';
import { CALC_RULE_BOUND, type CalcRuleView, loadCalcRuleView } from './calc-rule-view.js';
import { auditConfig, createConfig, lockConfigRow, requireSeeAllToRename, uniqueOr } from './config-kit.js';
import { type CalcWriteContext, presentHints } from './calc-rule-service.js';
import { readFieldCatalogVersion, shareLockFieldCatalog } from './field-catalog.js';

const reject = (reason: string, message: string, extra: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra });
const conflict = (reason: string, message: string, extra: object = {}) =>
  new AppError('CONFLICT', message, { reason, ...extra });

/** 规则已有的计算项目（保存前的状态）：原样保留判定与“保留已有引用”（停用判定）用。 */
interface ExistingItem {
  readonly targetFieldId: string;
  readonly formula: string;
  readonly binding: FormulaBindingState;
  /** 停用判定的“已有引用”：bound 取 bound 引用；unresolved 取候选；legacy 取按当前名称解析出的字段（契约 §3.3）。 */
  readonly held: ReadonlySet<string>;
}

/** 一个提交项目的处理结果：原样保留，或重新绑定。 */
type Plan =
  | { readonly kind: 'preserve'; readonly stored: string; readonly fieldIds: readonly string[] }
  | { readonly kind: 'bind'; readonly stored: string; readonly fieldIds: readonly string[] };

async function loadExisting(tx: Tx, tenantId: string, ruleId: string, full: readonly CatalogRow[]) {
  const items = await tx
    .select()
    .from(I)
    .where(and(eq(I.tenantId, tenantId), eq(I.ruleId, ruleId)));
  if (items.length === 0) return new Map<string, ExistingItem>();
  const refs = await tx
    .select()
    .from(R)
    .where(
      and(
        eq(R.tenantId, tenantId),
        inArray(
          R.itemId,
          items.map((item) => item.id),
        ),
      ),
    );
  const byName = (formula: string) => {
    const paths = new Set(formulaReferences(formula));
    return new Set(full.filter((field) => paths.has(formulaPath(field.name))).map((field) => field.id));
  };
  return new Map(
    items.map((item): [string, ExistingItem] => {
      const binding = item.formulaBinding as FormulaBindingState;
      const mine = refs.filter((ref) => ref.itemId === item.id);
      const held =
        binding === 'bound'
          ? new Set(mine.filter((ref) => ref.kind === 'bound').map((ref) => ref.fieldId))
          : binding === 'unresolved'
            ? new Set(mine.filter((ref) => ref.kind === 'candidate').map((ref) => ref.fieldId))
            : byName(item.formula);
      return [item.targetFieldId, { targetFieldId: item.targetFieldId, formula: item.formula, binding, held }];
    }),
  );
}

function bindError(failure: BindFailure, item: number): AppError {
  switch (failure.code) {
    case 'FORMULA_INVALID': {
      const issues = failure.issues.map(({ code, message, line, column, occurrence, choices }) => ({
        code,
        message,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(choices ? { choices } : {}),
      }));
      return reject('FORMULA_INVALID', failure.issues[0]?.message ?? '公式不合法', { item, issues });
    }
    case 'CALC_BINDING_STALE':
      return conflict('CALC_BINDING_STALE', '公式里的字段已改名或已变化，请刷新后重新编辑', {
        item,
        occurrence: failure.occurrence,
      });
    case 'FIELD_CATALOG_CHANGED':
      return conflict('FIELD_CATALOG_CHANGED', '字段目录已变化，请刷新后重新编辑', { item });
    case 'CALC_FIELD_NAME_AMBIGUOUS':
      return reject('CALC_FIELD_NAME_AMBIGUOUS', '公式里的字段名称对应多个字段，请改用字段的唯一名称', {
        item,
        occurrence: failure.occurrence,
      });
  }
}

const sameBindings = (a: readonly (string | null)[], b: readonly (string | null)[]) =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

interface Pass {
  readonly plans: readonly Plan[];
  readonly analysis: Extract<CalcAnalysis, { ok: true }>;
}

/** 一遍完整处理：目标字段 → 原样保留判定 → 输入限制 → 绑定 → 按 ID 的整体分析（类型、停用、排序、uses_ranking）。 */
function runPass(
  items: readonly BoundCalcItemBody[],
  full: readonly CatalogRow[],
  access: CatalogAccess | undefined,
  existing: ReadonlyMap<string, ExistingItem>,
  version: { current: number; submitted: number | undefined },
): Pass {
  const targets = items.map((item) => item.targetFieldId);
  if (new Set(targets).size !== targets.length) {
    throw reject('CALC_ITEM_TARGET_DUPLICATE', '同一规则里一个目标字段只能有一个计算项目');
  }
  const visible = visibleOf(full, access);
  const byId = new Map(visible.map((field) => [field.id, field]));
  const allFieldsVisible = visible.length === full.length;
  for (const [index, item] of items.entries()) {
    const field = byId.get(item.targetFieldId);
    if (!field) throw new AppError('NOT_FOUND', notFoundMessage('field'));
    const notAllowed = targetNotAllowed(field);
    if (notAllowed) throw reject('TARGET_FIELD_NOT_ALLOWED', notAllowed, { item: index });
    if (!existing.has(field.id) && !field.enabled) {
      throw reject('CALC_TARGET_DISABLED', '该字段已停用，不能新选作目标', { item: index });
    }
  }
  const plans: Plan[] = [];
  for (const [index, item] of items.entries()) {
    const kept = existing.get(item.targetFieldId);
    if (kept?.binding === 'bound') {
      // 契约 §1.6 第 1 步：只做字符串比较，命中即保留，不做输入限制与解析
      const current = renderFormula(kept.formula, { binding: 'bound', visibleFields: visible, allFieldsVisible });
      if (current.ok && current.text === item.formula && sameBindings(current.bindings, item.formulaBindings ?? [])) {
        plans.push({ kind: 'preserve', stored: kept.formula, fieldIds: [...kept.held] });
        continue;
      }
    }
    const limits = checkInputLimits(item.formula, { placeholders: true });
    if (!limits.ok) {
      throw reject('FORMULA_INVALID', '公式过长或过于复杂', {
        item: index,
        issues: [{ code: limits.reason, message: limits.message }],
      });
    }
    const bound = bindFormula(item.formula, {
      visibleFields: visible,
      proofs: item.formulaBindings,
      catalogVersion: version,
    });
    if (!bound.ok) throw bindError(bound.failure, index);
    plans.push({ kind: 'bind', stored: bound.stored, fieldIds: bound.fieldIds });
  }
  const boundItems: BoundCalcItem[] = items.map((item, index) => ({
    targetFieldId: item.targetFieldId,
    priority: item.priority,
    stored: plans[index]!.stored,
    description: item.description,
  }));
  const held = new Map([...existing].map(([target, entry]) => [target, entry.held]));
  const analysis = analyzeBoundItems(boundItems, full as readonly FormulaField[], held);
  if (!analysis.ok) throw analysisError(analysis, visible);
  return { plans, analysis };
}

/**
 * 整体分析失败（类型、多选、停用、排序）的错误：分析在全部字段上做，文案和字段列表里可能出现查看人看不到的字段
 * （原样保留的项目带着不可见引用）。句柄一律换成当前名称或占位符，字段 ID 只留可见的（DEC-376①）。
 */
function analysisError(analysis: Extract<CalcAnalysis, { ok: false }>, visible: readonly FormulaField[]): AppError {
  const names = new Map(visible.map((field) => [field.id.toLowerCase(), field.name]));
  const scrub = (text: string) =>
    text.replace(/@\{tr-field:([0-9a-f-]{36})\}/g, (_match, id: string) => {
      const name = names.get(id);
      return formulaPath(name ?? HIDDEN_FIELD_PLACEHOLDER);
    });
  const { reason, item, message, issues, fields } = analysis;
  return reject(reason, scrub(message), {
    item,
    ...(issues ? { issues: issues.map((entry) => ({ ...entry, message: scrub(entry.message) })) } : {}),
    ...(fields ? { fields: fields.filter((id) => names.has(id.toLowerCase())) } : {}),
  });
}

const signature = (pass: Pass) => pass.plans.map((plan) => `${plan.kind}:${plan.stored}`).join('\n');

/**
 * 保存前处理整组计算项目（契约 §2 第 2～5 步）：第一遍 → 一次性按序加字段行共享锁 → 版本行共享锁 → 第二遍，
 * 要求与第一遍逐处相同、引用集合不超出锁集合；否则 409 CALC_FIELD_CHANGED（受控，客户端显式重提）。
 */
async function prepareBoundItems(
  tx: Tx,
  ctx: CalcWriteContext,
  items: readonly BoundCalcItemBody[],
  existing: ReadonlyMap<string, ExistingItem>,
  submittedVersion: number | undefined,
) {
  const fullFirst = await loadFullCatalog(tx, ctx.tenantId);
  const first = runPass(items, fullFirst, ctx.fieldAccess, existing, {
    current: await readFieldCatalogVersion(tx, ctx.tenantId),
    submitted: submittedVersion,
  });
  const locked = [...new Set(first.analysis.fieldIds)].sort();
  await lockFields(tx, ctx.tenantId, locked);
  const current = await shareLockFieldCatalog(tx, ctx.tenantId);
  const second = runPass(items, await loadFullCatalog(tx, ctx.tenantId), ctx.fieldAccess, existing, {
    current,
    submitted: submittedVersion,
  });
  const changed =
    signature(first) !== signature(second) || !second.analysis.fieldIds.every((id) => locked.includes(id));
  if (changed) throw conflict('CALC_FIELD_CHANGED', '引用的字段正在变化，请刷新后重试');
  return second;
}

/** 引用表：删旧插新（项目变为 bound 时一并清掉候选引用，契约 §1.3）。 */
async function writeRefs(tx: Tx, ctx: CalcWriteContext, itemId: string, fieldIds: readonly string[]) {
  await tx.delete(R).where(and(eq(R.tenantId, ctx.tenantId), eq(R.itemId, itemId)));
  if (fieldIds.length === 0) return;
  await tx.insert(R).values(fieldIds.map((fieldId) => ({ tenantId: ctx.tenantId, itemId, fieldId, kind: 'bound' })));
}

async function writeItem(
  tx: Tx,
  ctx: CalcWriteContext,
  ruleId: string,
  item: BoundCalcItemBody,
  index: number,
  pass: Pass,
  existingId: string | undefined,
) {
  const plan = pass.plans[index]!;
  const common = {
    priority: item.priority,
    description: item.description ?? null,
    sortNo: index + 1,
    usesRanking: pass.analysis.usesRanking[index]!,
  };
  const binding = { formula: plan.stored, formulaBinding: 'bound', bindingIssue: null };
  if (existingId === undefined) {
    const [row] = await tx
      .insert(I)
      .values({ tenantId: ctx.tenantId, ruleId, targetFieldId: item.targetFieldId, ...common, ...binding })
      .returning({ id: I.id });
    await writeRefs(tx, ctx, row!.id, plan.fieldIds);
    return;
  }
  await tx
    .update(I)
    .set(plan.kind === 'bind' ? { ...common, ...binding } : common)
    .where(and(eq(I.tenantId, ctx.tenantId), eq(I.id, existingId)));
  if (plan.kind === 'bind') await writeRefs(tx, ctx, existingId, plan.fieldIds);
}

/** 按目标字段对应整组替换：相同目标更新（原样保留的只更新非公式列）、缺的删除（引用级联）、新的新增。 */
async function syncBoundItems(
  tx: Tx,
  ctx: CalcWriteContext,
  ruleId: string,
  items: readonly BoundCalcItemBody[],
  pass: Pass,
) {
  const rows = await tx
    .select({ id: I.id, targetFieldId: I.targetFieldId })
    .from(I)
    .where(and(eq(I.tenantId, ctx.tenantId), eq(I.ruleId, ruleId)));
  const idOf = new Map(rows.map((row) => [row.targetFieldId, row.id]));
  const keep = new Set(items.map((item) => item.targetFieldId));
  for (const row of rows) {
    if (!keep.has(row.targetFieldId)) await tx.delete(I).where(and(eq(I.tenantId, ctx.tenantId), eq(I.id, row.id)));
  }
  for (const [index, item] of items.entries()) {
    await writeItem(tx, ctx, ruleId, item, index, pass, idOf.get(item.targetFieldId));
  }
}

export async function createBoundCalcRule(
  tx: Tx,
  ctx: CalcWriteContext,
  input: BoundCalcRuleCreate,
): Promise<CalcRuleView> {
  const { items, fieldCatalogVersion, ...columns } = input;
  requireConfigCreatable(ctx.scope, 'calcRule');
  const pass = await prepareBoundItems(tx, ctx, items, new Map(), fieldCatalogVersion);
  return createConfig(tx, CALC_RULE_BOUND, ctx, columns, async (id) => {
    for (const [index, item] of items.entries()) await writeItem(tx, ctx, id, item, index, pass, undefined);
  });
}

export async function updateBoundCalcRule(
  tx: Tx,
  ctx: CalcWriteContext,
  id: string,
  patch: BoundCalcRulePatch,
): Promise<CalcRuleView> {
  await lockConfigRow(tx, CALC_RULE_BOUND, ctx, id);
  const before = (await loadCalcRuleView(tx, ctx.tenantId, id, true))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const { items, fieldCatalogVersion, ...columns } = patch;
  let pass: Pass | undefined;
  if (items) {
    const existing = await loadExisting(tx, ctx.tenantId, id, await loadFullCatalog(tx, ctx.tenantId));
    pass = await prepareBoundItems(tx, ctx, items, existing, fieldCatalogVersion);
  }
  await uniqueOr(CALC_RULE_BOUND.duplicate, CALC_RULE_BOUND.label, () =>
    tx
      .update(K)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(K.tenantId, ctx.tenantId), eq(K.id, id))),
  );
  if (items && pass) await syncBoundItems(tx, ctx, id, items, pass);
  const after = (await loadCalcRuleView(tx, ctx.tenantId, id, true))!;
  await auditConfig(tx, ctx, 'calcRule', 'update', id, before, after);
  return after;
}

/**
 * 授权复核（与业务绑定分开，首次执行与幂等重放共用、在命令之前）：目标字段与每处绑定证明里的字段在**当前**字段目录范围和
 * 列权限下仍可引用。不核对名称、版本与改名（那些是首次执行的业务校验；重放不重新执行，改名后重放必须照常返回）。
 */
export function requireBoundItemsReferenceable(
  full: readonly CatalogRow[],
  items: readonly BoundCalcItemBody[],
  access: CatalogAccess,
): void {
  const visible = new Set(visibleOf(full, access).map((field) => field.id));
  if (items.some((item) => !visible.has(item.targetFieldId))) throw new AppError('NOT_FOUND', notFoundMessage('field'));
  for (const [index, item] of items.entries()) {
    for (const [occurrence, proof] of (item.formulaBindings ?? []).entries()) {
      if (proof === null || proof === 'context' || visible.has(proof)) continue;
      throw reject('FORMULA_INVALID', '公式不合法', {
        item: index,
        issues: [{ code: 'UNKNOWN_FIELD', message: '找不到字段或变量', occurrence }],
      });
    }
  }
}

const CYCLE_HIDDEN = '存在循环依赖，涉及当前不可见的字段（不显示字段名称）；允许保存，计算时将整次失败';
const OTHER_HIDDEN = '部分保存提示涉及当前不可见的字段，未显示';
const UNVERIFIABLE = '部分公式当前无法完整校验（引用的字段可能已改名或删除），请检查后重新保存';
const NOT_REBOUND = '部分计算项目尚未改绑为按字段 ID 绑定（旧公式或改绑失败），无法完整校验，请重新保存这些公式';

/**
 * 写响应里的保存 / 启用提示（DEC-274，不静默省略循环）。检测在全部字段上做，输出里涉及看不到的字段的提示换成不含名称的提示
 * （可见性按字段 ID 判断）；order / blocked 按 items 列权限投影与 others 计数在 F082-4（契约 §5.2）。按规则里项目的存储形态：
 * - 全是 bound：按 ID 分析；**已有引用集合（引用表）传入**，合法保留的停用引用不当作新增引用（契约 §3.3，否则分析提前退出、循环提示丢失）；
 * - 全是 legacy：沿用 B5 按名称的检测（这些项目还是名称文本）；
 * - unresolved 或与 bound 混合：不能做完整检测，明确提示“无法完整校验”，order 仍列出全部目标（不返回全空的 hints）。
 */
export async function presentBoundHints(
  tx: Tx,
  tenantId: string,
  rawItems: CalcRuleView['items'],
  access: CatalogAccess | undefined,
): Promise<CalcHints> {
  const order = rawItems.map((item) => item.targetFieldId);
  const states = new Set(rawItems.map((item) => item.formulaBinding ?? 'legacy'));
  if (states.size === 1 && states.has('legacy')) return presentHints(tx, tenantId, rawItems, access);
  if (states.size !== 1 || !states.has('bound')) {
    return { order, warnings: [NOT_REBOUND], cycles: [], blocked: [] };
  }
  const full = await loadFullCatalog(tx, tenantId);
  const held = new Map(rawItems.map((item) => [item.targetFieldId, new Set(item.refFieldIds ?? [])]));
  const analysis = analyzeBoundItems(
    rawItems.map((item) => ({
      targetFieldId: item.targetFieldId,
      priority: item.priority,
      stored: item.formula,
      description: item.description,
    })),
    full,
    held,
  );
  if (!analysis.ok) return { order, warnings: [UNVERIFIABLE], cycles: [], blocked: [] };
  const visibleIds = new Set(visibleOf(full, access).map((field) => field.id));
  const shown = (key: string) => {
    const id = parseFieldHandle(key);
    return id === undefined ? key in FORMULA_CONTEXT_FIELDS : visibleIds.has(id);
  };
  const { hints, diagnostics } = analysis;
  const cycles = hints.cycles.filter((cycle) => cycle.every((id) => visibleIds.has(id)));
  const kept = diagnostics.filter((entry) => entry.fields.every(shown));
  const dropped = diagnostics.filter((entry) => !entry.fields.every(shown));
  const cycleKinds = new Set(['cycle', 'cyclesTruncated', 'blockedByCycle']);
  const warnings = kept.map((entry) => entry.message);
  if (dropped.some((entry) => cycleKinds.has(entry.kind)) || cycles.length < hints.cycles.length) {
    warnings.push(CYCLE_HIDDEN);
  }
  if (dropped.some((entry) => !cycleKinds.has(entry.kind))) warnings.push(OTHER_HIDDEN);
  return { ...hints, warnings, cycles };
}
