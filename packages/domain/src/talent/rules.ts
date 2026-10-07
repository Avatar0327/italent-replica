/** 人才标准引用指标的纯规则（docs/02_业务建模/23 §2.2）。不做 IO：指标状态由调用方在同一事务内加锁读取后传入。 */
import { TALENT_DEFAULT_WEIGHT, type TalentDimensionType } from './catalog.js';

export interface CriterionDimensionInput {
  readonly dimensionId: string;
  readonly weight?: number | null;
  readonly target?: number | null;
}

export interface ReferencedDimension {
  readonly id: string;
  readonly type: TalentDimensionType;
  readonly enabled: boolean;
  readonly libraryEnabled: boolean;
}

export type CriterionDimensionReason = 'DUPLICATE_DIMENSION' | 'DIMENSION_NOT_ENABLED' | 'WEIGHT_TARGET_ABILITY_ONLY';

export interface CriterionDimensionViolation {
  readonly reason: CriterionDimensionReason;
  readonly dimensionId: string;
}

const isSet = (value: number | null | undefined) => value !== undefined && value !== null;

/**
 * 返回第一处违规，没有违规返回 null。
 * - 同一标准内一个指标只引用一次；
 * - TC-R4：只有已启用的指标与指标库才能被**新**引用；标准里已有的引用不因指标停用而失效（existing）；
 * - TC-R3：只有能力指标可以设置权重和目标（0 也算设置）。
 * referenced 必须包含 items 里的每个指标（缺失的由调用方先按不存在处理）。
 */
export function criterionDimensionViolation(
  items: readonly CriterionDimensionInput[],
  referenced: ReadonlyMap<string, ReferencedDimension>,
  existing: ReadonlySet<string>,
): CriterionDimensionViolation | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.dimensionId)) return { reason: 'DUPLICATE_DIMENSION', dimensionId: item.dimensionId };
    seen.add(item.dimensionId);
  }
  for (const item of items) {
    const dimension = referenced.get(item.dimensionId);
    if (!dimension) throw new Error(`未加载引用的指标 ${item.dimensionId}`);
    if (!existing.has(item.dimensionId) && !(dimension.enabled && dimension.libraryEnabled)) {
      return { reason: 'DIMENSION_NOT_ENABLED', dimensionId: item.dimensionId };
    }
  }
  for (const item of items) {
    const dimension = referenced.get(item.dimensionId)!;
    if (dimension.type !== 'ability' && (isSet(item.weight) || isSet(item.target))) {
      return { reason: 'WEIGHT_TARGET_ABILITY_ONLY', dimensionId: item.dimensionId };
    }
  }
  return null;
}

export interface ExistingReference {
  readonly weight: number | null;
  readonly target: number | null;
}

export interface CriterionDimensionValue {
  readonly dimensionId: string;
  readonly weight: number | null;
  readonly target: number | null;
}

/**
 * 引用行最终保存的权重与目标（DEC-281②）：传了就用传的值（显式 null 即清空）；没传时已有引用保持原值，
 * 新增的能力指标引用权重缺省为 1，其余为空。须先通过 criterionDimensionViolation（潜力 / 经历不会带值）。
 */
export function criterionDimensionValues(
  items: readonly CriterionDimensionInput[],
  referenced: ReadonlyMap<string, ReferencedDimension>,
  existing: ReadonlyMap<string, ExistingReference>,
): CriterionDimensionValue[] {
  return items.map((item) => {
    const before = existing.get(item.dimensionId);
    const ability = referenced.get(item.dimensionId)?.type === 'ability';
    const fallbackWeight = before ? before.weight : ability ? TALENT_DEFAULT_WEIGHT : null;
    return {
      dimensionId: item.dimensionId,
      weight: item.weight === undefined ? fallbackWeight : item.weight,
      target: item.target === undefined ? (before?.target ?? null) : item.target,
    };
  });
}
