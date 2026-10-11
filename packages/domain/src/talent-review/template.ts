/**
 * 盘点模板的领域常量与保存校验（纯函数；R3-T04 设计 §2.3，TR-R11～R20）。模板结构 = 版本内冻结的流程步骤（来自流程节点）
 * + 模块（指标评估 / 盘点信息 / 继任信息）+ 步骤 × 角色 × 模块的权限。本文件只放不读库的规则；引用对象是否存在 / 可见 /
 * 已启用由接口层校验。
 */
import { TALENT_DIMENSION_TYPES } from '../talent/catalog.js';
import { roundDecimal } from '../expression/index.js';
import type { FlowNodeKind } from './form-flow.js';

export const TEMPLATE_MODULE_KINDS = ['indicator', 'info', 'succession'] as const;
export type TemplateModuleKind = (typeof TEMPLATE_MODULE_KINDS)[number];
/** 指标来源（TR-R14）：任职资格，或人才标准（按主职职务绑定 / 指定一个标准）。 */
export const INDICATOR_SOURCES = ['qualification', 'talent_standard'] as const;
export const CRITERION_MODES = ['designated', 'by_job'] as const;
/** 算分方式（TR-R15）：加权求和、算术平均、算术求和、按指标数目。 */
export const SCORING_METHODS = ['weighted_sum', 'arithmetic_mean', 'arithmetic_sum', 'by_count'] as const;
export type ScoringMethod = (typeof SCORING_METHODS)[number];
export const SUCCESSION_ACCESS = ['edit', 'view', 'hidden'] as const;
export type SuccessionAccess = (typeof SUCCESSION_ACCESS)[number];
export const TEMPLATE_MAX_MODULES = 30;
export const TEMPLATE_MAX_PERMISSIONS = 2000;
export const WEIGHT_TOTAL = 100;

/** 校验不通过：reason 是机器可读的原因码，message 是给人看的说明。 */
export interface TemplateViolation {
  readonly reason: string;
  readonly message: string;
}
const violation = (reason: string, message: string): TemplateViolation => ({ reason, message });

export interface ModuleInput {
  readonly kind: TemplateModuleKind;
  readonly name: string;
  readonly source?: (typeof INDICATOR_SOURCES)[number] | null;
  readonly criterionMode?: (typeof CRITERION_MODES)[number] | null;
  readonly criterionId?: string | null;
  readonly dimensionTypes?: readonly string[] | null;
  readonly scoring?: ScoringMethod | null;
  readonly scoreRuleId?: string | null;
  readonly moduleGradeId?: string | null;
  readonly fieldIds?: readonly string[] | null;
}

function indicatorProblem(module: ModuleInput): TemplateViolation | null {
  if (!module.source) return violation('MODULE_SOURCE_REQUIRED', `指标评估模块“${module.name}”须选择指标来源`);
  if (!module.scoring || !module.scoreRuleId) {
    return violation('MODULE_SCORING_REQUIRED', `指标评估模块“${module.name}”须选择算分方式与评价规则`);
  }
  if (module.source === 'qualification') {
    const extra = module.criterionMode || module.criterionId || module.dimensionTypes?.length;
    return extra ? violation('MODULE_CRITERION_NOT_ALLOWED', '任职资格来源不带人才标准设置') : null;
  }
  if (!module.criterionMode)
    return violation('MODULE_CRITERION_MODE_REQUIRED', '人才标准来源须选择按主职职务或指定标准');
  if (module.criterionMode === 'designated' && !module.criterionId) {
    return violation('MODULE_CRITERION_REQUIRED', '指定人才标准须选择标准');
  }
  if (module.criterionMode === 'by_job' && module.criterionId) {
    return violation('MODULE_CRITERION_NOT_ALLOWED', '按主职职务绑定的人才标准不指定标准');
  }
  const types: readonly string[] = TALENT_DIMENSION_TYPES;
  if (module.dimensionTypes?.some((type) => !types.includes(type))) {
    return violation('MODULE_DIMENSION_INVALID', '维度只能是能力、潜力、经历');
  }
  return null;
}

/** 模块自身的规则：名称版本内唯一（结果公式按名称引用）、各类型的必填 / 禁填项。 */
export function checkModules(modules: readonly ModuleInput[]): TemplateViolation | null {
  const names = new Set<string>();
  for (const module of modules) {
    if (names.has(module.name)) return violation('MODULE_NAME_DUPLICATE', `模块名称“${module.name}”重复`);
    names.add(module.name);
    if (module.kind === 'indicator') {
      const problem = indicatorProblem(module);
      if (problem) return problem;
    } else if (module.source || module.scoring || module.scoreRuleId || module.moduleGradeId || module.criterionId) {
      return violation('MODULE_KIND_MISMATCH', `“${module.name}”不是指标评估模块，不能带评分配置`);
    }
    if (module.kind !== 'info' && module.fieldIds?.length) {
      return violation('MODULE_KIND_MISMATCH', `“${module.name}”不是盘点信息模块，不能带展示字段`);
    }
    if (new Set(module.fieldIds ?? []).size !== (module.fieldIds ?? []).length) {
      return violation('MODULE_FIELD_DUPLICATE', `“${module.name}”的展示字段重复`);
    }
  }
  return null;
}

/** 按指标数目算分只能配等级类评价规则，且必须有按指标数目的模块等级（TR-R15）。 */
export function checkByCount(rule: { kind: string }, grade: { mode: string } | null): TemplateViolation | null {
  if (rule.kind !== 'grade') return violation('MODULE_BY_COUNT_RULE', '按指标数目算分只能选等级类评价规则');
  if (!grade || grade.mode !== 'count') {
    return violation('MODULE_BY_COUNT_GRADE', '按指标数目算分须选择按指标数目的模块等级');
  }
  return null;
}

export interface StepShape {
  readonly nodeKey: string;
  readonly kind: FlowNodeKind;
  readonly roleIds: readonly string[];
}
export interface PermissionInput {
  readonly nodeKey: string;
  readonly roleId?: string | null;
  readonly moduleName: string;
  readonly visible?: boolean;
  readonly scoreEnabled?: boolean;
  readonly scoreRequired?: boolean;
  readonly commentEnabled?: boolean;
  readonly commentRequired?: boolean;
  readonly weight?: number | null;
  readonly successorAccess?: SuccessionAccess | null;
  readonly targetAccess?: SuccessionAccess | null;
}

/**
 * 步骤权限行的规则（TR-R16、R18）：行对应已有的步骤 / 模块；会签步骤的行必须指到该步骤的角色，单人步骤不带角色；必填须以启用
 * 为前提；权重只在启用评分时有意义；继任两项只用于继任模块，指标权限只用于指标模块；同一席位 × 模块至多一行。
 */
export function checkPermissions(
  steps: readonly StepShape[],
  modules: readonly Pick<ModuleInput, 'kind' | 'name'>[],
  rows: readonly PermissionInput[],
): TemplateViolation | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const step = steps.find((s) => s.nodeKey === row.nodeKey);
    const module = modules.find((m) => m.name === row.moduleName);
    if (!step) return violation('PERMISSION_STEP_UNKNOWN', `步骤“${row.nodeKey}”不存在`);
    if (!module) return violation('PERMISSION_MODULE_UNKNOWN', `模块“${row.moduleName}”不存在`);
    if (module.kind === 'info')
      return violation('PERMISSION_INFO_MODULE', '盘点信息模块的字段权限由步骤选用的表单决定');
    if (step.kind === 'countersign' && !(row.roleId && step.roleIds.includes(row.roleId))) {
      return violation('PERMISSION_ROLE_INVALID', `会签步骤“${row.nodeKey}”的权限须指向该步骤的角色`);
    }
    if (step.kind === 'single' && row.roleId) {
      return violation('PERMISSION_ROLE_INVALID', `单人步骤“${row.nodeKey}”的权限不带角色`);
    }
    const key = `${row.nodeKey}|${row.roleId ?? ''}|${row.moduleName}`;
    if (seen.has(key)) return violation('PERMISSION_DUPLICATE', '同一步骤 × 角色 × 模块只能配置一次');
    seen.add(key);
    const problem = permissionRowProblem(module.kind, row);
    if (problem) return problem;
  }
  return null;
}

function permissionRowProblem(kind: TemplateModuleKind, row: PermissionInput): TemplateViolation | null {
  const succession = row.successorAccess != null || row.targetAccess != null;
  if (kind === 'succession') {
    const indicator = row.scoreEnabled || row.commentEnabled || row.weight != null;
    return indicator ? violation('PERMISSION_KIND_MISMATCH', '继任模块只配置继任者与目标继任的访问档') : null;
  }
  if (succession) return violation('PERMISSION_KIND_MISMATCH', '继任访问档只用于继任信息模块');
  if (row.scoreRequired && row.scoreEnabled === false) {
    return violation('PERMISSION_REQUIRED_NEEDS_ENABLED', '评分必填须以启用评分为前提');
  }
  if (row.commentRequired && row.commentEnabled === false) {
    return violation('PERMISSION_REQUIRED_NEEDS_ENABLED', '评语必填须以启用评语为前提');
  }
  if (row.weight != null && row.scoreEnabled === false) {
    return violation('PERMISSION_WEIGHT_NEEDS_SCORE', '只有启用评分的席位才有权重');
  }
  return null;
}

export interface WeightRow {
  readonly moduleName: string;
  readonly visible: boolean;
  readonly scoreEnabled: boolean;
  readonly weight: number | null;
}
export interface ConfigError {
  readonly moduleName: string;
  readonly code: 'WEIGHT_SUM_NOT_100';
  readonly sum: number;
}

/**
 * 配置错误（TR-R16，D-03）：同一指标评估模块各评分席位的权重之和 ≠ 100% → 报错，允许保存、不拦截启动（照原站只标红）。
 * 权重缺省为空按 0 计；和按 4 位小数比较。
 */
export function weightConfigErrors(
  modules: readonly Pick<ModuleInput, 'kind' | 'name'>[],
  rows: readonly WeightRow[],
): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const module of modules) {
    if (module.kind !== 'indicator') continue;
    const sum = roundDecimal(
      rows
        .filter((row) => row.moduleName === module.name && row.visible && row.scoreEnabled)
        .reduce((total, row) => total + (row.weight ?? 0), 0),
      4,
      'half-up',
    );
    if (sum !== WEIGHT_TOTAL) errors.push({ moduleName: module.name, code: 'WEIGHT_SUM_NOT_100', sum });
  }
  return errors;
}
