/**
 * 按 ID 绑定的计算项目分析（F-082，契约 §1.5、§4）：输入是规范文本（字段引用为句柄 `@{tr-field:<uuid>}`），
 * 字段目录里的键就是句柄，所以改名、重名都不影响类型检查、依赖排序、uses_ranking 与多选 / 停用判定。
 * 与 analyzeCalcItems（按名称、B5 路径）并存，由总开关选择；两者返回同一种 CalcAnalysis，差别是：
 * - 目标字段与其他字段重名可以保存（不再有 CALC_FIELD_NAME_AMBIGUOUS）；
 * - hints.cycles 是目标字段 ID 数组（不是字段路径），由客户端对应到项目；
 * - 失败里的 fields 是字段 ID，不含名称（名称由调用方按查看人的可见范围渲染）；
 * - 排序诊断的文案用字段当前名称（orderComputationItems 的 display 回调），结构化 fields 仍是句柄。
 */
import {
  createDefaultRegistry,
  fieldHandle,
  orderComputationItems,
  parseFieldHandle,
  validateFormula,
  type ExpressionFieldKind,
} from '../expression/index.js';
import {
  FORMULA_CONTEXT_FIELDS,
  formulaFieldKind,
  formulaPath,
  type CalcAnalysis,
  type CalcFailureReason,
  type CalcIssue,
  type FormulaField,
} from './calc-rule.js';

export interface BoundCalcItem {
  readonly targetFieldId: string;
  readonly priority: number;
  /** 规范文本（bindFormula 的产出）。 */
  readonly stored: string;
  readonly description?: string | null | undefined;
}

/** 目标字段 ID → 该项目已有的引用字段 ID：区分“保留已有引用”和“新增引用”（停用后不可新引用，契约 §3.3）。 */
export type HeldReferences = ReadonlyMap<string, ReadonlySet<string>>;

const toIssue = (error: { code: string; message: string; line: number; column: number }): CalcIssue => ({
  code: error.code,
  message: error.message,
  line: error.line,
  column: error.column,
});

/**
 * 分析一条规则的全部计算项目。catalog 是**全部**字段（系统执行，不按查看人裁剪；按查看人的投影在 F082-4）。
 * 返回第一个不合法的项目（下标 = items 下标）；通过时给出每项的 uses_ranking、保存提示与引用的字段 id。
 */
export function analyzeBoundItems(
  items: readonly BoundCalcItem[],
  catalog: readonly FormulaField[],
  held: HeldReferences = new Map(),
): CalcAnalysis {
  const byId = new Map(catalog.map((field) => [field.id.toLowerCase(), field]));
  const fieldOf = (key: string): FormulaField | undefined => {
    const id = parseFieldHandle(key);
    return id === undefined ? undefined : byId.get(id);
  };
  const isKnownField = (path: string) => fieldOf(path) !== undefined || path in FORMULA_CONTEXT_FIELDS;
  const fieldKind = (path: string): ExpressionFieldKind | undefined => {
    const field = fieldOf(path);
    return field ? formulaFieldKind(field.kind) : FORMULA_CONTEXT_FIELDS[path];
  };
  const display = (key: string) => {
    const field = fieldOf(key);
    return field ? formulaPath(field.name) : key;
  };
  const fail = (reason: CalcFailureReason, item: number, message: string, extra: object = {}): CalcAnalysis => ({
    ok: false,
    reason,
    item,
    message,
    ...extra,
  });
  const registry = createDefaultRegistry();
  const validation = { isKnownField, registry, storage: true };
  const usesRanking: boolean[] = [];
  const fieldIds = new Set(items.map((item) => item.targetFieldId));
  for (const [index, item] of items.entries()) {
    if (!byId.has(item.targetFieldId.toLowerCase())) return fail('FORMULA_INVALID', index, '目标字段不存在');
    // 先不带类型，找出多选字段的引用并给出专用错误码（带类型时引擎报笼统的参数类型错误）
    const untyped = validateFormula(item.stored, validation);
    if (!untyped.ok) return fail('FORMULA_INVALID', index, '公式不合法', { issues: untyped.errors.map(toIssue) });
    const multi = untyped.fields.flatMap((path) => (fieldOf(path)?.kind === 'multi_option' ? [fieldOf(path)!.id] : []));
    if (multi.length > 0) return fail('MULTI_OPTION_IN_FORMULA', index, '公式不能引用多选字段', { fields: multi });
    // TODO(需取证 #188)：D-15 文本与数字比较的保存期拦截是否扩展到计算规则（③），取证前不实现
    const typed = validateFormula(item.stored, { ...validation, fieldKind });
    if (!typed.ok) return fail('FORMULA_INVALID', index, '公式不合法', { issues: typed.errors.map(toIssue) });
    const kept = held.get(item.targetFieldId) ?? new Set<string>();
    for (const path of typed.fields) {
      const field = fieldOf(path);
      if (!field) continue;
      fieldIds.add(field.id);
      if (!field.enabled && !kept.has(field.id)) {
        return fail('CALC_FORMULA_FIELD_DISABLED', index, '公式引用的字段已停用，不能新引用', { fields: [field.id] });
      }
    }
    usesRanking.push(typed.functions.some((name) => registry.resolve(name)?.skipInTodoTrigger === true));
  }
  const compItems = items.map((item) => ({
    field: fieldHandle(item.targetFieldId),
    priority: item.priority,
    formula: item.stored,
    ...(item.description ? { description: item.description } : {}),
  }));
  const ordering = orderComputationItems(compItems, { ...validation, fieldKind, display });
  if (!ordering.ok) return fail('FORMULA_INVALID', 0, ordering.failure.message);
  const idOfKey = new Map(compItems.map((item, index) => [item.field, items[index]!.targetFieldId]));
  const ids = (keys: readonly string[]) => keys.map((key) => idOfKey.get(key)!);
  return {
    ok: true,
    usesRanking,
    fieldIds: [...fieldIds],
    diagnostics: ordering.diagnostics,
    hints: {
      order: ids(ordering.order.map((item) => item.field)),
      warnings: [...ordering.warnings],
      cycles: ordering.cycles.map((cycle) => ids(cycle)),
      blocked: ids(ordering.blocked),
    },
  };
}
