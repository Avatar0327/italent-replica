/**
 * 角色加权计分（docs/02_业务建模/25 §3.2 E3-R11、E3-R13；E3-R6 不计分选项）：
 * - 每个评价者：题目分 →（题目权重）基础指标分 →（指标权重）复合指标分 → 总分；
 * - 角色分 = 该角色评价者分数的简单平均；
 * - 他评分 = Σ(角色分 × 角色权重) / Σ角色权重，缺失角色的权重从分子、分母同时去掉；
 * - “不做评价 / 不计分”选项不计入统计，不按 0 分算；被限定角色之外的题目不参与该评价者的计分。
 * 指标聚合模式、缺失角色的个性化权重、去最高最低分不在首版范围（`25` §4）。
 */
import { childrenOf, type Dimension, isLeaf, type QuestionnaireModel, type ScoreMethod } from './questionnaire.js';

export interface SheetScores {
  readonly total: number | null;
  readonly dimensions: ReadonlyMap<string, number | null>;
  readonly questions: ReadonlyMap<string, number | null>;
}

interface Weighted {
  readonly score: number | null;
  readonly weight: number;
}

function combine(entries: readonly Weighted[], method: ScoreMethod): number | null {
  const scored = entries.filter((e): e is { score: number; weight: number } => e.score !== null);
  if (scored.length === 0) return null;
  if (method === 'weighted_sum') return scored.reduce((sum, e) => sum + (e.score * e.weight) / 100, 0);
  const weight = scored.reduce((sum, e) => sum + e.weight, 0);
  return weight > 0 ? scored.reduce((sum, e) => sum + e.score * e.weight, 0) / weight : null;
}

function applies(roleIds: readonly string[], roleId: string): boolean {
  return roleIds.length === 0 || roleIds.includes(roleId);
}

/** 某角色需要作答的条目：关键行为为题目，等级评定为基础指标；指标的角色限定向下传递。 */
export function answerableItems(model: QuestionnaireModel, roleId: string): string[] {
  const allowed = new Set<string>();
  const visit = (parentId: string | null) => {
    for (const dimension of childrenOf(model, parentId)) {
      if (!applies(dimension.roleIds, roleId)) continue;
      allowed.add(dimension.id);
      visit(dimension.id);
    }
  };
  visit(null);
  if (model.type === 'rating')
    return model.dimensions.filter((d) => allowed.has(d.id) && isLeaf(model, d)).map((d) => d.id);
  return model.questions.filter((q) => allowed.has(q.dimensionId) && applies(q.roleIds, roleId)).map((q) => q.id);
}

/** 一份答卷（一个评价者对一个评价对象的一个套卷）的各层得分；answers 为 条目 → 选项。 */
export function scoreSheet(
  model: QuestionnaireModel,
  roleId: string,
  answers: ReadonlyMap<string, string>,
): SheetScores {
  const optionValue = new Map(model.scales.flatMap((s) => s.options.map((o) => [o.id, o.notScored ? null : o.value])));
  const items = new Set(answerableItems(model, roleId));
  const valueOf = (itemId: string): number | null => {
    if (!items.has(itemId)) return null;
    const option = answers.get(itemId);
    return option === undefined ? null : (optionValue.get(option) ?? null);
  };
  const questions = new Map(model.questions.map((q) => [q.id, valueOf(q.id)]));
  const dimensions = new Map<string, number | null>();
  // 关键行为只支持加权平均（E3-R1）；等级评定按套卷设置
  const method: ScoreMethod = model.type === 'key_behavior' ? 'weighted_average' : model.scoreMethod;
  const scoreOf = (dimension: Dimension): number | null => {
    let score: number | null;
    if (!isLeaf(model, dimension))
      score = combine(
        childrenOf(model, dimension.id).map((c) => ({ score: scoreOf(c), weight: c.weight })),
        method,
      );
    else if (model.type === 'rating') score = valueOf(dimension.id);
    else
      score = combine(
        model.questions
          .filter((q) => q.dimensionId === dimension.id)
          .map((q) => ({ score: questions.get(q.id) ?? null, weight: q.weight })),
        'weighted_average',
      );
    dimensions.set(dimension.id, score);
    return score;
  };
  const total = combine(
    childrenOf(model, null).map((d) => ({ score: scoreOf(d), weight: d.weight })),
    method,
  );
  return { total, dimensions, questions };
}

/** 满分：每个可答条目都选分值最高的计分选项时的总分（优秀率控制用，E3-R9）。 */
export function maxTotal(model: QuestionnaireModel, roleId: string): number | null {
  const best = new Map<string, string>();
  const scaleOf = (itemId: string) =>
    model.type === 'rating'
      ? model.dimensions.find((d) => d.id === itemId)?.scaleId
      : model.questions.find((q) => q.id === itemId)?.scaleId;
  for (const itemId of answerableItems(model, roleId)) {
    const options = model.scales.find((s) => s.id === scaleOf(itemId))?.options ?? [];
    const top = options
      .filter((o) => !o.notScored && o.value !== null)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
    if (top) best.set(itemId, top.id);
  }
  return scoreSheet(model, roleId, best).total;
}

/**
 * E3-R9 优秀率控制（仅一次评价多人）：某评价者评 n 人时，达到优秀线的人数上限 = ⌈n × 上限比例⌉。
 * 例：12 人、上限 20% → 3。
 */
export function excellentLimit(evaluatedCount: number, maxRatePercent: number): number {
  return Math.ceil((evaluatedCount * maxRatePercent) / 100 - 1e-9);
}

export function isExcellent(total: number | null, max: number | null, linePercent: number): boolean {
  if (total === null || max === null || max <= 0) return false;
  return (total / max) * 100 >= linePercent - 1e-9;
}

export interface RaterSheet {
  readonly roleId: string;
  readonly isSelf: boolean;
  readonly scores: SheetScores;
}

export type ScoreLevel = 'questionnaire' | 'dimension' | 'question';

export interface AggregateScore {
  readonly level: ScoreLevel;
  readonly itemId: string | null;
  readonly scope: 'self' | 'other' | 'role';
  readonly roleId: string | null;
  readonly score: number | null;
  readonly raterCount: number;
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 一个评价对象在一个套卷上的聚合得分（E3-R11、E3-R13）：自评、各他评角色分、他评分，逐层（总分 / 指标 / 题目）。 */
export function aggregateScores(model: QuestionnaireModel, sheets: readonly RaterSheet[]): AggregateScore[] {
  const levels: { level: ScoreLevel; itemId: string | null; pick: (s: SheetScores) => number | null }[] = [
    { level: 'questionnaire', itemId: null, pick: (s) => s.total },
    ...model.dimensions.map((d) => ({
      level: 'dimension' as const,
      itemId: d.id,
      pick: (s: SheetScores) => s.dimensions.get(d.id) ?? null,
    })),
    ...model.questions.map((q) => ({
      level: 'question' as const,
      itemId: q.id,
      pick: (s: SheetScores) => s.questions.get(q.id) ?? null,
    })),
  ];
  const result: AggregateScore[] = [];
  for (const { level, itemId, pick } of levels) {
    const valuesOf = (filter: (s: RaterSheet) => boolean) =>
      sheets
        .filter(filter)
        .map((s) => pick(s.scores))
        .filter((v): v is number => v !== null);
    const self = valuesOf((s) => s.isSelf);
    if (self.length) result.push({ level, itemId, scope: 'self', roleId: null, score: average(self), raterCount: 1 });
    let weighted = 0;
    let weights = 0;
    let raters = 0;
    for (const role of model.roles.filter((r) => !r.isSelf)) {
      const values = valuesOf((s) => !s.isSelf && s.roleId === role.roleId);
      if (values.length === 0) continue; // 缺失角色：权重从分子、分母同时去掉（E3-R13）
      const score = average(values)!;
      result.push({ level, itemId, scope: 'role', roleId: role.roleId, score, raterCount: values.length });
      weighted += score * role.weight;
      weights += role.weight;
      raters += values.length;
    }
    if (raters > 0)
      result.push({
        level,
        itemId,
        scope: 'other',
        roleId: null,
        score: weights > 0 ? weighted / weights : null,
        raterCount: raters,
      });
  }
  return result;
}
