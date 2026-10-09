/**
 * 盘点计算规则的保存分析（纯函数；R3-T04 设计 §2.2 calc_rules / _items、§4.5(d)、§7 计算规则行；TR-R27～R30）：
 * - 公式按字段名引用盘点字段（`盘点对象.<名>`，26 §8），字段目录 = 调用方给出的可见字段 + 项目 / 方案三个固定字段；
 * - 保存校验 validateFormula，依赖排序 orderComputationItems（先优先级、再按引用依赖；循环与依赖矛盾只提示、不拦截，DEC-274）；
 * - uses_ranking 由公式用到的函数派生（排名函数在待办触发时不计算，DEC-260）；
 * - 目标字段类型允许性（§4.5(d) 表）与公式引用多选字段（DEC-314②，取证前禁用）。
 */
import {
  createDefaultRegistry,
  orderComputationItems,
  validateFormula,
  type ExpressionFieldKind,
} from '../expression/index.js';
import type { TalentReviewFieldKind } from './fields.js';

export const CALC_RULE_WINDOWS = ['before_project_end', 'before_project_start'] as const;
export type CalcRuleWindow = (typeof CALC_RULE_WINDOWS)[number];

/** 公式里盘点字段的写法前缀。 */
export const FORMULA_OBJECT = '盘点对象';
/** 项目 / 方案字段（设计 §5 RankingPort 行）：排名范围条件与分组可用，不是盘点字段目录里的字段。 */
export const FORMULA_CONTEXT_FIELDS: Readonly<Record<string, ExpressionFieldKind>> = {
  '盘点活动.项目名称': 'text',
  '盘点活动.盘点年度': 'text',
  '盘点对象.盘点方案': 'text',
};
export const formulaPath = (fieldName: string) => `${FORMULA_OBJECT}.${fieldName}`;

export interface FormulaField {
  readonly id: string;
  readonly name: string;
  readonly kind: TalentReviewFieldKind;
  readonly systemWritten: boolean;
  readonly enabled: boolean;
}
export interface CalcItemInput {
  readonly targetFieldId: string;
  readonly priority: number;
  readonly formula: string;
  readonly description?: string | null | undefined;
}

/** 目标字段只能是标量字段：多选和系统写入字段不能作目标（设计 §4.5(d)，保存时 400 TARGET_FIELD_NOT_ALLOWED）。 */
export function targetNotAllowed(field: Pick<FormulaField, 'kind' | 'systemWritten'>): string | null {
  if (field.kind === 'multi_option') return '多选字段不能作为计算项目的目标';
  if (field.systemWritten) return '系统写入的字段不能作为计算项目的目标';
  return null;
}

export interface CalcIssue {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}
export interface CalcHints {
  /** 计算顺序（目标字段 id）：先优先级、再按依赖。 */
  readonly order: string[];
  readonly warnings: string[];
  /** 循环依赖的代表环（字段路径），保存不拦截，计算时整次失败（DEC-274）。 */
  readonly cycles: string[][];
  /** 成环或依赖成环、无法计算的项目（目标字段 id）。 */
  readonly blocked: string[];
}
export type CalcFailureReason =
  'FORMULA_INVALID' | 'MULTI_OPTION_IN_FORMULA' | 'CALC_FIELD_NAME_AMBIGUOUS' | 'CALC_FORMULA_FIELD_DISABLED';
export type CalcAnalysis =
  | {
      readonly ok: true;
      readonly usesRanking: boolean[];
      readonly hints: CalcHints;
      /** 目标字段与公式引用的全部盘点字段 id：保存前按序加锁、锁内复核。 */
      readonly fieldIds: string[];
    }
  | {
      readonly ok: false;
      readonly reason: CalcFailureReason;
      readonly item: number;
      readonly message: string;
      readonly issues?: CalcIssue[];
      readonly fields?: string[];
    };

const staticKind = (kind: TalentReviewFieldKind): ExpressionFieldKind => (kind === 'option' ? 'text' : kind);

/** 公式里引用的字段路径（语法不合法时为空）；已存公式的引用判定共用，不依赖字段目录。 */
export function formulaReferences(formula: string): string[] {
  const parsed = validateFormula(formula, { isKnownField: () => true });
  return parsed.ok ? [...parsed.fields] : [];
}

/**
 * 分析一条规则的全部计算项目——字段绑定只做一次：公式里的字段只认调用方给出的、可见字段的**完整路径**（`盘点对象.<名>`，
 * 重名字段有歧义不进字段目录；不接受目标字段的短名），类型检查、依赖排序、uses_ranking、多选与停用判定都基于这同一个绑定。
 * `held`：规则里已有项目的现存公式（目标字段 id → 公式），用来区分“保留已有引用”和“新增引用”（停用后不可新引用，设计 §7）。
 * 返回第一个不合法的项目（下标 = items 下标）；通过时给出每项的 uses_ranking、保存提示与引用的字段 id。
 */
export function analyzeCalcItems(
  items: readonly CalcItemInput[],
  catalog: readonly FormulaField[],
  held: ReadonlyMap<string, string> = new Map(),
): CalcAnalysis {
  const counts = new Map<string, number>();
  for (const field of catalog) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
  const byPath = new Map(
    catalog.filter((field) => counts.get(field.name) === 1).map((field) => [formulaPath(field.name), field]),
  );
  const byId = new Map(catalog.map((field) => [field.id, field]));
  const isKnownField = (path: string) => byPath.has(path) || path in FORMULA_CONTEXT_FIELDS;
  const fieldKind = (path: string): ExpressionFieldKind | undefined => {
    const field = byPath.get(path);
    return field ? staticKind(field.kind) : FORMULA_CONTEXT_FIELDS[path];
  };
  const fail = (reason: CalcFailureReason, item: number, message: string, extra: object = {}): CalcAnalysis => ({
    ok: false,
    reason,
    item,
    message,
    ...extra,
  });
  const registry = createDefaultRegistry();
  const compItems = items.map((item) => ({
    field: formulaPath(byId.get(item.targetFieldId)!.name),
    priority: item.priority,
    formula: item.formula,
    ...(item.description ? { description: item.description } : {}),
  }));
  const usesRanking: boolean[] = [];
  const fieldIds = new Set(items.map((item) => item.targetFieldId));
  for (const [index, item] of items.entries()) {
    if (counts.get(byId.get(item.targetFieldId)!.name)! > 1) {
      return fail('CALC_FIELD_NAME_AMBIGUOUS', index, '目标字段与其他字段重名，公式无法区分，请先修改字段名称');
    }
    const formula = compItems[index]!.formula;
    // 先不带类型，按名称找出多选字段的引用并给出专用错误码（带类型时引擎报笼统的参数类型错误）
    const untyped = validateFormula(formula, { isKnownField, registry });
    if (!untyped.ok) return fail('FORMULA_INVALID', index, '公式不合法', { issues: untyped.errors.map(toIssue) });
    const multi = untyped.fields.filter((path) => byPath.get(path)?.kind === 'multi_option');
    if (multi.length > 0) return fail('MULTI_OPTION_IN_FORMULA', index, '公式不能引用多选字段', { fields: multi });
    const typed = validateFormula(formula, { isKnownField, fieldKind, registry });
    if (!typed.ok) return fail('FORMULA_INVALID', index, '公式不合法', { issues: typed.errors.map(toIssue) });
    const kept = new Set(formulaReferences(held.get(item.targetFieldId) ?? ''));
    for (const path of typed.fields) {
      const field = byPath.get(path);
      if (!field) continue;
      fieldIds.add(field.id);
      if (!field.enabled && !kept.has(path)) {
        return fail('CALC_FORMULA_FIELD_DISABLED', index, '公式引用的字段已停用，不能新引用', { fields: [path] });
      }
    }
    usesRanking.push(typed.functions.some((name) => registry.resolve(name)?.skipInTodoTrigger === true));
  }
  const ordering = orderComputationItems(compItems, { isKnownField, fieldKind, registry });
  if (!ordering.ok) return fail('FORMULA_INVALID', 0, ordering.failure.message);
  const idOfPath = new Map(compItems.map((item, index) => [item.field, items[index]!.targetFieldId]));
  const ids = (paths: readonly string[]) => paths.map((path) => idOfPath.get(path)!);
  return {
    ok: true,
    usesRanking,
    fieldIds: [...fieldIds],
    hints: {
      order: ids(ordering.order.map((item) => item.field)),
      warnings: [...ordering.warnings],
      cycles: ordering.cycles.map((cycle) => [...cycle]),
      blocked: ids(ordering.blocked),
    },
  };
}

/**
 * 授权复核用（与业务分析分开）：逐个项目、逐个引用检查公式里的字段是否都在调用方给出的可见字段里——只认可见字段的完整路径
 * 与项目 / 方案固定字段，不做类型、重名、停用等业务判断，也不在第一个业务错误处停下（PR #184 第 2 轮：分析器先报重名就返回，
 * 后面项目里已撤出范围的字段会漏检）。返回第一个含不可见 / 不存在字段引用的项目及其 UNKNOWN_FIELD 问题；全部可见返回 null。
 */
export function unreferenceableItem(
  items: readonly Pick<CalcItemInput, 'formula'>[],
  visible: readonly Pick<FormulaField, 'name'>[],
): { readonly item: number; readonly issues: CalcIssue[] } | null {
  const paths = new Set(visible.map((field) => formulaPath(field.name)));
  const isKnownField = (path: string) => paths.has(path) || path in FORMULA_CONTEXT_FIELDS;
  const registry = createDefaultRegistry();
  for (const [index, item] of items.entries()) {
    const checked = validateFormula(item.formula, { isKnownField, registry });
    if (checked.ok) continue;
    const unknown = checked.errors.filter((error) => error.code === 'UNKNOWN_FIELD');
    if (unknown.length > 0) return { item: index, issues: unknown.map(toIssue) };
  }
  return null;
}

const toIssue = (error: { code: string; message: string; line: number; column: number }): CalcIssue => ({
  code: error.code,
  message: error.message,
  line: error.line,
  column: error.column,
});
