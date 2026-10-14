/**
 * 存量计算公式改绑（F-082 契约 §6.1、§6.2、§6.4、§6.5）：把一个租户全部 legacy 项目（retryUnresolved 时含 unresolved）
 * 按迁移时 B5 的解析规则固定绑定。一个租户一个事务：
 * - 成功 → 规范文本 + bound 引用（清掉候选），formula_binding = bound；
 * - 失败 → formula_binding = unresolved + 原因码，原文不动，追加候选引用（只增不减，已有候选一律保留）；
 * - 不改规则 revision（渲染后的公式与改绑前逐字相同，客户端手里的 revision 继续有效）；
 * - 幂等：bound 行不读不写，重复执行没有变化就没有写入、没有审计。
 *
 * 锁序（§3.4）：R（涉及的规则行，排序后 FOR UPDATE）→ F（引用 / 候选字段行，排序后一次 FOR SHARE）→ V（字段目录版本行 FOR SHARE）→ I。
 * 版本行共享锁之后字段的新建 / 改名 / 删除都被挡住，所以第二遍的字段目录就是最终依据；它若需要第一遍没锁住的字段
 * （两遍之间刚提交的同名新字段），不能再补取 F 锁（会反向等待），整个租户回滚，由运维用新的命令 ID 重试。
 */
import {
  and,
  asc,
  eq,
  inArray,
  sql,
  talentReviewCalcItemRefs as R,
  talentReviewCalcRuleItems as I,
  type Tx,
} from '@italent/db';
import { type FormulaBindingState, rebindLegacyFormula, type RebindIssue, type RebindResult } from '@italent/domain';
import { AppError } from '../../errors.js';
import { type CatalogRow, loadFullCatalog, lockFields } from './calc-rule-catalog.js';
import { loadCalcRuleView } from './calc-rule-view.js';
import { shareLockFieldCatalog } from './field-catalog.js';

export interface RebindInput {
  /** 同时重试 unresolved 项目（默认只处理 legacy）。 */
  readonly retryUnresolved: boolean;
}

/** 报告只有 ID 与原因码，不含公式原文与字段名称（契约 §6.4）。 */
export interface RebindReport {
  readonly rules: number;
  readonly bound: number;
  readonly unresolved: readonly { ruleId: string; targetFieldId: string; reason: RebindIssue }[];
}

/** 一条有变化的规则的审计前后值（原始视图：规范文本、存储形态、字段名与引用，读取时再按查看人裁剪）。 */
export interface RebindAudit {
  readonly ruleId: string;
  readonly before: unknown;
  readonly after: unknown;
}

interface ScopeItem {
  readonly id: string;
  readonly ruleId: string;
  readonly targetFieldId: string;
  readonly formula: string;
  readonly binding: FormulaBindingState;
  readonly issue: string | null;
}
interface Plan {
  readonly item: ScopeItem;
  readonly result: RebindResult;
}

async function loadScope(tx: Tx, tenantId: string, input: RebindInput, ruleIds?: readonly string[]) {
  const states = input.retryUnresolved ? ['legacy', 'unresolved'] : ['legacy'];
  const rows = await tx
    .select({
      id: I.id,
      ruleId: I.ruleId,
      targetFieldId: I.targetFieldId,
      formula: I.formula,
      binding: I.formulaBinding,
      issue: I.bindingIssue,
    })
    .from(I)
    .where(
      and(
        eq(I.tenantId, tenantId),
        inArray(I.formulaBinding, states),
        ...(ruleIds ? [inArray(I.ruleId, [...ruleIds])] : []),
      ),
    )
    .orderBy(asc(I.ruleId), asc(I.id));
  return rows.map((row): ScopeItem => ({ ...row, binding: row.binding as FormulaBindingState }));
}

/** R：涉及的规则行排序后一次 FOR UPDATE（与保存 / 删除规则同一把锁，串行化同一规则上的写入）。 */
async function lockRules(tx: Tx, tenantId: string, ruleIds: readonly string[]) {
  if (ruleIds.length === 0) return;
  const ids = sql.join(
    ruleIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`SELECT id FROM talent_review_calc_rules
    WHERE tenant_id = ${tenantId}::uuid AND id IN (${ids}) ORDER BY id FOR UPDATE`);
}

const plansOf = (items: readonly ScopeItem[], catalog: readonly CatalogRow[]): Plan[] =>
  items.map((item) => ({ item, result: rebindLegacyFormula(item.formula, catalog) }));

/** 一个计划需要的字段行（绑定的引用或候选）：写引用表前要先锁住，避免与删除字段交错。 */
const fieldIdsOf = ({ result }: Plan) => (result.ok ? result.fieldIds : result.candidates);

async function applyPlan(tx: Tx, tenantId: string, { item, result }: Plan): Promise<boolean> {
  if (result.ok) {
    await tx
      .update(I)
      .set({ formula: result.stored, formulaBinding: 'bound', bindingIssue: null })
      .where(and(eq(I.tenantId, tenantId), eq(I.id, item.id)));
    // 变为 bound：候选引用一并换成 bound 引用（契约 §1.3）
    await tx.delete(R).where(and(eq(R.tenantId, tenantId), eq(R.itemId, item.id)));
    if (result.fieldIds.length > 0) {
      await tx
        .insert(R)
        .values(result.fieldIds.map((fieldId) => ({ tenantId, itemId: item.id, fieldId, kind: 'bound' })));
    }
    return true;
  }
  let changed = false;
  if (item.binding !== 'unresolved' || item.issue !== result.issue) {
    await tx
      .update(I)
      .set({ formulaBinding: 'unresolved', bindingIssue: result.issue })
      .where(and(eq(I.tenantId, tenantId), eq(I.id, item.id)));
    changed = true;
  }
  if (result.candidates.length > 0) {
    // 只增不减：已有的候选（含改名固化的）保留，新的追加
    const added = await tx
      .insert(R)
      .values(result.candidates.map((fieldId) => ({ tenantId, itemId: item.id, fieldId, kind: 'candidate' })))
      .onConflictDoNothing()
      .returning({ fieldId: R.fieldId });
    if (added.length > 0) changed = true;
  }
  return changed;
}

/**
 * 改绑一个租户（调用方已把事务切到该租户）。返回报告与每条有变化的规则的审计前后值（由命令层同事务写审计）。
 */
export async function rebindTenantCalcFormulas(
  tx: Tx,
  tenantId: string,
  input: RebindInput,
): Promise<{ report: RebindReport; audits: RebindAudit[] }> {
  const candidates = await loadScope(tx, tenantId, input);
  const ruleIds = [...new Set(candidates.map((item) => item.ruleId))];
  await lockRules(tx, tenantId, ruleIds);
  // 锁住规则行之后重读：期间被保存成 bound 的项目不再处理
  const first = plansOf(await loadScope(tx, tenantId, input, ruleIds), await loadFullCatalog(tx, tenantId));
  const locked = [...new Set(first.flatMap(fieldIdsOf))].sort();
  await lockFields(tx, tenantId, locked);
  await shareLockFieldCatalog(tx, tenantId);
  // 版本行共享锁之后字段目录不再变化：第二遍是最终依据
  const items = await loadScope(tx, tenantId, input, ruleIds);
  const plans = plansOf(items, await loadFullCatalog(tx, tenantId));
  const lockedSet = new Set(locked);
  if (!plans.flatMap(fieldIdsOf).every((id) => lockedSet.has(id))) {
    throw new AppError('CONFLICT', '字段目录在改绑期间发生变化，请用新的命令 ID 重试', {
      reason: 'CALC_FIELD_CHANGED',
    });
  }

  const touched = [...new Set(items.map((item) => item.ruleId))];
  const before = new Map<string, unknown>();
  for (const ruleId of touched) before.set(ruleId, await loadCalcRuleView(tx, tenantId, ruleId, true));

  const changedRules = new Set<string>();
  let bound = 0;
  for (const plan of plans) {
    if (await applyPlan(tx, tenantId, plan)) changedRules.add(plan.item.ruleId);
    if (plan.result.ok) bound += 1;
  }

  const audits: RebindAudit[] = [];
  for (const ruleId of [...changedRules].sort()) {
    audits.push({ ruleId, before: before.get(ruleId), after: await loadCalcRuleView(tx, tenantId, ruleId, true) });
  }
  const unresolved = plans.flatMap(({ item, result }) =>
    result.ok ? [] : [{ ruleId: item.ruleId, targetFieldId: item.targetFieldId, reason: result.issue }],
  );
  return { report: { rules: changedRules.size, bound, unresolved }, audits };
}
