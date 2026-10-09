/**
 * 套卷模型与启用校验（docs/02_业务建模/25 §3.1 E3-R1～R8）。两类套卷：
 * - 关键行为：指标（可两层：复合 → 基础）→ 题目，评价者对题目打分，只支持加权平均；
 * - 等级评定：指标（复合 → 基础），评价者对基础指标选等级，加权平均或加权求和（E3-R7）。
 */
import { SURVEY360_LIMITS } from './rules.js';

export type QuestionnaireType = 'key_behavior' | 'rating';
export type ScoreMethod = 'weighted_average' | 'weighted_sum';

export interface ScaleOption {
  readonly id: string;
  readonly scaleId: string;
  readonly label: string;
  /** 不计分选项为空。 */
  readonly value: number | null;
  readonly notScored: boolean;
  readonly remarkRequired: boolean;
}

export interface Scale {
  readonly id: string;
  readonly name: string;
  readonly options: readonly ScaleOption[];
}

export interface Dimension {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly weight: number;
  /** 等级评定的基础指标所用评定等级。 */
  readonly scaleId: string | null;
  /** 限定评价角色（E3-R8）；空 = 全部角色。 */
  readonly roleIds: readonly string[];
}

export interface Question {
  readonly id: string;
  readonly dimensionId: string;
  readonly text: string;
  readonly weight: number;
  readonly scaleId: string;
  readonly roleIds: readonly string[];
}

export interface QuestionnaireRole {
  readonly roleId: string;
  readonly weight: number;
  readonly isSelf: boolean;
}

export interface QuestionnaireModel {
  readonly type: QuestionnaireType;
  readonly scoreMethod: ScoreMethod;
  readonly roles: readonly QuestionnaireRole[];
  readonly scales: readonly Scale[];
  readonly dimensions: readonly Dimension[];
  readonly questions: readonly Question[];
}

export interface QuestionnaireIssue {
  readonly code: string;
  readonly message: string;
  readonly itemId?: string;
}

export function childrenOf(model: QuestionnaireModel, parentId: string | null): Dimension[] {
  return model.dimensions.filter((d) => d.parentId === parentId);
}

export function isLeaf(model: QuestionnaireModel, dimension: Dimension): boolean {
  return !model.dimensions.some((d) => d.parentId === dimension.id);
}

/** 启用前的完整校验（E3-R4～R8）；返回全部问题，空数组表示可启用。 */
export function validateQuestionnaire(model: QuestionnaireModel): QuestionnaireIssue[] {
  return [...roleIssues(model), ...scaleIssues(model), ...structureIssues(model), ...methodIssues(model)];
}

function roleIssues(model: QuestionnaireModel): QuestionnaireIssue[] {
  const issues: QuestionnaireIssue[] = [];
  const others = model.roles.filter((r) => !r.isSelf);
  if (others.length === 0) issues.push({ code: 'NO_OTHER_ROLE', message: '套卷至少需要一个他评角色' });
  if (model.roles.length > SURVEY360_LIMITS.rolesPerQuestionnaire)
    issues.push({ code: 'TOO_MANY_ROLES', message: '单套卷最多 15 个角色（含自评）' });
  if (model.roles.some((r) => !Number.isInteger(r.weight) || r.weight < 0))
    issues.push({ code: 'ROLE_WEIGHT_INVALID', message: '角色权重须为不小于 0 的整数' });
  // E3-R5：自评权重固定为 0；他评角色权重不能全为 0（AC-360-02）
  if (model.roles.some((r) => r.isSelf && r.weight !== 0))
    issues.push({ code: 'SELF_WEIGHT_NOT_ZERO', message: '自评权重固定为 0' });
  if (others.length > 0 && others.every((r) => r.weight === 0))
    issues.push({ code: 'OTHER_ROLE_WEIGHTS_ZERO', message: '他评角色权重不能全为 0' });
  const known = new Set(model.roles.map((r) => r.roleId));
  const restricted = [...model.dimensions, ...model.questions].filter((i) => i.roleIds.some((id) => !known.has(id)));
  for (const item of restricted)
    issues.push({ code: 'ROLE_RESTRICTION_UNKNOWN', message: '限定的评价角色不在套卷角色中', itemId: item.id });
  return issues;
}

function scaleIssues(model: QuestionnaireModel): QuestionnaireIssue[] {
  const issues: QuestionnaireIssue[] = [];
  for (const scale of model.scales) {
    if (scale.options.length === 0 || scale.options.length > SURVEY360_LIMITS.optionsPerScale)
      issues.push({ code: 'OPTION_COUNT_INVALID', message: '选项须为 1～15 个', itemId: scale.id });
    if (!scale.options.some((o) => !o.notScored))
      issues.push({ code: 'SCALE_WITHOUT_SCORE', message: '选项中至少有一个计分选项', itemId: scale.id });
  }
  return issues;
}

function structureIssues(model: QuestionnaireModel): QuestionnaireIssue[] {
  const issues: QuestionnaireIssue[] = [];
  if (model.dimensions.length === 0) issues.push({ code: 'NO_DIMENSION', message: '套卷至少需要一个指标' });
  for (const dimension of model.dimensions) {
    const leaf = isLeaf(model, dimension);
    const questions = model.questions.filter((q) => q.dimensionId === dimension.id);
    if (model.type === 'key_behavior') {
      if (leaf && questions.length === 0)
        issues.push({ code: 'LEAF_WITHOUT_QUESTION', message: '基础指标下至少需要一道题目', itemId: dimension.id });
      if (!leaf && questions.length > 0)
        issues.push({ code: 'QUESTION_ON_COMPOSITE', message: '题目只能挂在基础指标下', itemId: dimension.id });
    } else {
      if (questions.length > 0)
        issues.push({ code: 'RATING_WITH_QUESTION', message: '等级评定套卷不设题目', itemId: dimension.id });
      if (leaf && !dimension.scaleId)
        issues.push({ code: 'RATING_WITHOUT_SCALE', message: '基础指标必须设置评定等级', itemId: dimension.id });
    }
  }
  for (const parentId of [null, ...model.dimensions.map((d) => d.id)]) {
    const siblings = childrenOf(model, parentId);
    if (siblings.length === 0) continue;
    const total = siblings.reduce((sum, d) => sum + d.weight, 0);
    if (total === 0)
      issues.push({ code: 'WEIGHTS_ALL_ZERO', message: '同级指标权重不能全为 0', itemId: parentId ?? '' });
    // E3-R7：等级评定的基础指标权重之和 = 100%
    else if (model.type === 'rating' && Math.abs(total - 100) > 1e-9)
      issues.push({ code: 'WEIGHTS_NOT_100', message: '同级指标权重之和须为 100%', itemId: parentId ?? '' });
    // E3-R7：同一复合指标下的基础指标必须用同一套评定等级
    if (model.type === 'rating' && parentId !== null) {
      const scales = new Set(siblings.filter((d) => isLeaf(model, d)).map((d) => d.scaleId));
      if (scales.size > 1)
        issues.push({ code: 'RATING_MIXED_SCALES', message: '同一复合指标下须用同一套评定等级', itemId: parentId });
    }
  }
  for (const dimensionId of new Set(model.questions.map((q) => q.dimensionId))) {
    const total = model.questions.filter((q) => q.dimensionId === dimensionId).reduce((s, q) => s + q.weight, 0);
    if (total === 0) issues.push({ code: 'WEIGHTS_ALL_ZERO', message: '题目权重不能全为 0', itemId: dimensionId });
  }
  return issues;
}

/** E3-R1 / E3-R7：关键行为只支持加权平均；等级评定按评定等级套数与是否含不计分项限定总分规则。 */
export function allowedScoreMethods(model: QuestionnaireModel): readonly ScoreMethod[] {
  if (model.type === 'key_behavior') return ['weighted_average'];
  const scaleIds = new Set(model.dimensions.filter((d) => isLeaf(model, d) && d.scaleId).map((d) => d.scaleId));
  if (scaleIds.size >= 2) return ['weighted_sum'];
  const scale = model.scales.find((s) => scaleIds.has(s.id));
  if (scale?.options.some((o) => o.notScored)) return ['weighted_average'];
  return ['weighted_average', 'weighted_sum'];
}

function methodIssues(model: QuestionnaireModel): QuestionnaireIssue[] {
  return allowedScoreMethods(model).includes(model.scoreMethod)
    ? []
    : [{ code: 'SCORE_METHOD_NOT_ALLOWED', message: '该套卷的总分计算规则不可用' }];
}
