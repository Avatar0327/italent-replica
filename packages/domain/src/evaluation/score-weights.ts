/**
 * 评分项权重纯函数（EV-R4 / EV-R40，R3-T02 设计 §7.2；拆分方案 B2）。无 I/O，权重一律用百分数（80 表示 80%）。
 * - average：100% ÷ 参与评分项数；不显示的指标、能力标准为空的指标不参与；输入权重不用；
 * - weighted：指标 = 标准整体权重 × 明细权重%（空按 0%），通用项 = 自身权重（空按 0%）；
 * - sum：不加权，权重为 null。
 * 不显示 / 能力标准为空的指标没有评分框，三种口径下都不参与；加权时也不把它们的权重分给其他指标（规格 24 EV-R40 只说
 * “标准中部分指标权重为空的按 0%”，没有再分配规则）。
 */
import { roundDecimal } from '../expression/index.js';

export const FORM_TOTAL_RULES = ['average', 'weighted', 'sum'] as const;
export type FormTotalRule = (typeof FORM_TOTAL_RULES)[number];

export interface StandardIndicatorInput {
  readonly id: string;
  /** 指标在标准中的权重%，空 = 未设置。 */
  readonly weight: number | null;
  /** 评价表隐藏了该指标（hidden_target_ids）。 */
  readonly hidden: boolean;
  /** 该指标在当前申请级别下没有能力标准内容。 */
  readonly capabilityStandardEmpty: boolean;
}

export type ScoreItemInput =
  | { readonly kind: 'general'; readonly id: string; readonly weight: number | null }
  | {
      readonly kind: 'standard';
      readonly id: string;
      /** 标准整体权重%。 */
      readonly weight: number | null;
      readonly indicators: readonly StandardIndicatorInput[];
    };

export interface EffectiveWeight {
  /** 评分项（评价表里的一行）。 */
  readonly itemId: string;
  /** 标准项下的指标；通用项为 null。 */
  readonly indicatorId: string | null;
  readonly weight: number | null;
}

export type ScoreWeightsResult =
  | { readonly ok: true; readonly weights: readonly EffectiveWeight[] }
  | {
      readonly ok: false;
      readonly code: 'WEIGHT_INVALID';
      readonly itemId: string;
      readonly indicatorId: string | null;
    };

/** 乘法的浮点尾差（33.3 × 30 / 100）按 10 位小数收口；百分数权重的有效位远小于此。 */
const WEIGHT_DIGITS = 10;

const isValidWeight = (weight: number | null): boolean =>
  weight === null || (Number.isFinite(weight) && weight >= 0 && weight <= 100);

const participates = (indicator: StandardIndicatorInput): boolean =>
  !indicator.hidden && !indicator.capabilityStandardEmpty;

function firstInvalidWeight(items: readonly ScoreItemInput[]): ScoreWeightsResult | undefined {
  for (const item of items) {
    if (!isValidWeight(item.weight)) return { ok: false, code: 'WEIGHT_INVALID', itemId: item.id, indicatorId: null };
    if (item.kind === 'general') continue;
    const bad = item.indicators.find((indicator) => !isValidWeight(indicator.weight));
    if (bad) return { ok: false, code: 'WEIGHT_INVALID', itemId: item.id, indicatorId: bad.id };
  }
  return undefined;
}

interface ParticipatingRow {
  readonly itemId: string;
  readonly indicatorId: string | null;
  /** 通用项自身权重 / 指标在标准中的权重。 */
  readonly own: number | null;
  /** 标准整体权重；通用项没有这一层。 */
  readonly standard?: { readonly weight: number | null };
}

/** 参与评分的行（保持评价表顺序）：通用项一行，标准项展开成它的可见指标。 */
function participants(items: readonly ScoreItemInput[]): ParticipatingRow[] {
  return items.flatMap((item): ParticipatingRow[] => {
    if (item.kind === 'general') return [{ itemId: item.id, indicatorId: null, own: item.weight }];
    return item.indicators.filter(participates).map((indicator) => ({
      itemId: item.id,
      indicatorId: indicator.id,
      own: indicator.weight,
      standard: { weight: item.weight },
    }));
  });
}

export function computeScoreWeights(rule: FormTotalRule, items: readonly ScoreItemInput[]): ScoreWeightsResult {
  const rows = participants(items);
  if (rule === 'average') {
    const each = rows.length === 0 ? 0 : 100 / rows.length;
    return { ok: true, weights: rows.map(({ itemId, indicatorId }) => ({ itemId, indicatorId, weight: each })) };
  }
  if (rule === 'sum') {
    return { ok: true, weights: rows.map(({ itemId, indicatorId }) => ({ itemId, indicatorId, weight: null })) };
  }
  const invalid = firstInvalidWeight(items);
  if (invalid) return invalid;
  const weights = rows.map(({ itemId, indicatorId, own, standard }) => {
    // 通用项：自身权重；标准下的指标：标准整体权重 × 明细权重%（EV-R4，空按 0%）
    const weight = standard
      ? roundDecimal(((standard.weight ?? 0) * (own ?? 0)) / 100, WEIGHT_DIGITS, 'half-up')
      : (own ?? 0);
    return { itemId, indicatorId, weight };
  });
  return { ok: true, weights };
}
