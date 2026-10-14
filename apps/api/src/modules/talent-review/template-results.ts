/** 模板结果规则：复用 F-082 绑定 / 两遍锁校验 / 分析；模块路径在版本内冻结（DEC-387）。 */
import {
  analyzeBoundItems,
  bindFormula,
  renderFormula,
  checkInputLimits,
  targetNotAllowed,
  type ExpressionFieldKind,
  type FormulaField,
  type BindFailure,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { visibleOf, type CatalogAccess, type CatalogRow } from './calc-rule-catalog.js';
import { bindResultModules, carryResultModules, type ResultModule } from './template-result-modules.js';
import type { ResultRuleInput } from './template-extra-input.js';

export interface ResultRuleView {
  targetFieldId: string;
  formula: string;
  priority: number;
  formulaBinding: 'bound';
  refFieldIds: string[];
  refModuleIds: string[];
}
type Module = { name: string; kind: string };
export const moduleFields = (modules: readonly Module[]): Record<string, ExpressionFieldKind> =>
  Object.fromEntries(
    modules
      .filter((m) => m.kind === 'indicator')
      .flatMap((m) => [
        [`模块.${m.name}.得分`, 'number'],
        [`模块.${m.name}.等级`, 'text'],
      ]),
  );
const invalid = (reason: string, message = '结果公式不合法') => new AppError('VALIDATION_FAILED', message, { reason });
const conflict = (reason: string) => new AppError('CONFLICT', '字段目录已变化，请刷新后重新编辑', { reason });
const heldOf = (rows: readonly ResultRuleView[]) => new Map(rows.map((r) => [r.targetFieldId, new Set(r.refFieldIds)]));

export function analyzeResults(
  rows: readonly ResultRuleView[],
  full: readonly FormulaField[],
  modules: readonly Module[],
) {
  return analyzeBoundItems(
    rows.map((r) => ({ ...r, stored: r.formula })),
    full,
    heldOf(rows),
    moduleFields(modules),
  );
}
function rejectBinding(failure: BindFailure): never {
  if (failure.code === 'CALC_BINDING_STALE' || failure.code === 'FIELD_CATALOG_CHANGED') throw conflict(failure.code);
  throw new AppError('VALIDATION_FAILED', '结果公式不合法', {
    reason: failure.code,
    ...(failure.code === 'FORMULA_INVALID' ? { issues: failure.issues } : {}),
  });
}

function bindPass(
  submitted: readonly ResultRuleInput[],
  previous: readonly ResultRuleView[],
  full: readonly CatalogRow[],
  access: CatalogAccess | undefined,
  modules: readonly ResultModule[],
  previousModules: readonly ResultModule[],
  current: number,
  submittedVersion: number | undefined,
): ResultRuleView[] {
  const visible = visibleOf(full, access);
  const fields = moduleFields(modules);
  const targets = new Set<string>();
  const rows = submitted.map((item): ResultRuleView => {
    if (targets.has(item.targetFieldId)) throw invalid('RESULT_TARGET_DUPLICATE');
    targets.add(item.targetFieldId);
    const field = visible.find((f) => f.id === item.targetFieldId);
    if (!field) throw new AppError('NOT_FOUND', '盘点字段不存在');
    if (targetNotAllowed(field)) throw invalid('TARGET_FIELD_NOT_ALLOWED');
    const kept = previous.find((r) => r.targetFieldId === item.targetFieldId);
    if (!field.enabled && !kept) throw invalid('CALC_TARGET_DISABLED');
    if (kept) {
      const rendered = renderFormula(kept.formula, { binding: 'bound', visibleFields: visible });
      if (
        rendered.ok &&
        rendered.text === item.formula &&
        JSON.stringify(rendered.bindings) === JSON.stringify(item.formulaBindings ?? [])
      ) {
        return { ...carryResultModules(kept, previousModules, modules, full), priority: item.priority };
      }
    }
    if (!checkInputLimits(item.formula, { placeholders: true }).ok) throw invalid('FORMULA_INVALID');
    const bound = bindFormula(item.formula, {
      visibleFields: visible,
      proofs: item.formulaBindings,
      catalogVersion: { current, submitted: submittedVersion },
      versionField: (path) => Object.hasOwn(fields, path),
    });
    if (!bound.ok) rejectBinding(bound.failure);
    return {
      targetFieldId: item.targetFieldId,
      priority: item.priority,
      formula: bound.stored,
      formulaBinding: 'bound',
      refFieldIds: [...bound.fieldIds],
      refModuleIds: bindResultModules(bound.stored, modules),
    };
  });
  // DEC-391：类型分析复用引擎，额外的“文本与数字比较”保存期拦截不启用。
  const analysis = analyzeBoundItems(
    rows.map((r) => ({ ...r, stored: r.formula })),
    full,
    heldOf(previous),
    fields,
  );
  if (!analysis.ok) throw invalid(analysis.reason);
  return rows;
}

function carryPass(
  previous: readonly ResultRuleView[],
  previousModules: readonly ResultModule[],
  modules: readonly ResultModule[],
  full: readonly CatalogRow[],
): ResultRuleView[] {
  const carried = previous.map((row) => carryResultModules(row, previousModules, modules, full));
  if (carried.length && !analyzeResults(carried, full, modules).ok) {
    throw invalid('FORMULA_INVALID', '模块变更后结果公式不再有效，请同时修改结果规则');
  }
  return carried;
}

/** 显式与沿用共用同一只读规划；两遍所用目录及全部取锁由 buildPlan 提供。 */
export function resultRulesPass(
  ctx: { tenantId: string; fieldAccess?: CatalogAccess | undefined },
  modules: readonly ResultModule[],
  previousModules: readonly ResultModule[],
  submitted: readonly ResultRuleInput[] | undefined,
  previous: readonly ResultRuleView[],
  version: number | undefined,
): (full: CatalogRow[], current: number) => ResultRuleView[] {
  return (full, current) =>
    submitted === undefined
      ? carryPass(previous, previousModules, modules, full)
      : bindPass(submitted, previous, full, ctx.fieldAccess, modules, previousModules, current, version);
}
