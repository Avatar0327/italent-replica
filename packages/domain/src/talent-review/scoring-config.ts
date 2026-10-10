/**
 * 评价规则 / 模块等级 / 字段映射的领域规则（R3-T04 设计 §2.2、§4.2、TR-R9 / R15 / R20）。纯函数，无 IO：
 * 接口层的保存校验与 PR-C 的算分、带入共用同一份，保证配置时拦的规则与运行时匹配的规则一致。
 */
import { roundDecimal } from '../expression/index.js';

export const SCORE_RULE_KINDS = ['numeric', 'grade'] as const;
export type ScoreRuleKind = (typeof SCORE_RULE_KINDS)[number];
/** 等级类评价规则的录入方式：下拉或平铺（TR-R20）。 */
export const SCORE_DISPLAYS = ['dropdown', 'tile'] as const;
export const MAPPING_SCENES = ['carry_last', 'talent_pool'] as const;
export type MappingScene = (typeof MAPPING_SCENES)[number];

/** 模块得分的比较精度：与存储一致，4 位小数（设计 §4.2，DEC-299 十进制舍入）。 */
const SCORE_DIGITS = 4;
const round = (score: number) => roundDecimal(score, SCORE_DIGITS, 'half-up');

export interface ScoreInterval {
  readonly minScore: number;
  readonly maxScore: number;
}
export interface CountThreshold {
  readonly minCount: number;
}

/**
 * 按得分匹配模块等级：区间含下界不含上界，**最后一段（上界最大的一段）含上界**；得分先按 4 位小数舍入再比较。
 * 低于第一段下界或高于最后一段上界都无匹配（返回 null，等级为空）。
 */
export function matchModuleGradeByScore<T extends ScoreInterval>(items: readonly T[], score: number): T | null {
  if (items.length === 0 || !Number.isFinite(score)) return null;
  const value = round(score);
  const lastMax = Math.max(...items.map((item) => item.maxScore));
  return (
    items.find(
      (item) => value >= item.minScore && (value < item.maxScore || (value === lastMax && item.maxScore === lastMax)),
    ) ?? null
  );
}

/** 按指标数目匹配模块等级：取已达到的最高门槛（“做到 ≥ N 项”）；未达最低门槛无匹配。 */
export function matchModuleGradeByCount<T extends CountThreshold>(items: readonly T[], count: number): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (count >= item.minCount && (best === null || item.minCount > best.minCount)) best = item;
  }
  return best;
}

export interface GradeItemInput {
  readonly name: string;
  readonly value: string;
  readonly minScore?: number | null;
  readonly maxScore?: number | null;
  readonly minCount?: number | null;
}
export type GradeItemsProblem =
  | 'GRADE_ITEMS_REQUIRED'
  | 'GRADE_ITEMS_MIXED'
  | 'GRADE_INTERVAL_INVALID'
  | 'GRADE_INTERVAL_OVERLAP'
  | 'GRADE_COUNT_DUPLICATE'
  | 'GRADE_ITEM_DUPLICATE';

/** 一个模块等级的等级项口径二选一：得分区间或按指标数目；区间不重叠（相接允许），门槛 / 名称 / 值不重复。 */
export function gradeItemsProblem(items: readonly GradeItemInput[]): GradeItemsProblem | null {
  if (items.length === 0) return 'GRADE_ITEMS_REQUIRED';
  const byCount = items.map((item) => item.minCount != null);
  // 同一项不能既带数量门槛又带分数边界；整组也只能用一种口径（否则存储时会悄悄丢掉其中一种）
  if (items.some((item) => item.minCount != null && (item.minScore != null || item.maxScore != null))) {
    return 'GRADE_ITEMS_MIXED';
  }
  if (byCount.some((flag) => flag !== byCount[0])) return 'GRADE_ITEMS_MIXED';
  if (new Set(items.map((item) => item.name)).size !== items.length) return 'GRADE_ITEM_DUPLICATE';
  if (new Set(items.map((item) => item.value)).size !== items.length) return 'GRADE_ITEM_DUPLICATE';
  if (byCount[0]) {
    return new Set(items.map((item) => item.minCount)).size === items.length ? null : 'GRADE_COUNT_DUPLICATE';
  }
  const intervals = items.map((item) => ({ min: item.minScore ?? Number.NaN, max: item.maxScore ?? Number.NaN }));
  if (intervals.some((i) => !(i.max > i.min))) return 'GRADE_INTERVAL_INVALID';
  const sorted = [...intervals].sort((a, b) => a.min - b.min);
  for (const [index, current] of sorted.entries()) {
    if (index > 0 && current.min < sorted[index - 1]!.max) return 'GRADE_INTERVAL_OVERLAP';
  }
  return null;
}

export interface MappingFieldShape {
  readonly kind: string;
  /** 单选 / 多选的选项 value 集合；其他类型为空。 */
  readonly optionValues: readonly string[];
}
export type MappingProblem = 'MAPPING_KIND_MISMATCH' | 'MAPPING_OPTIONS_MISMATCH';

/** 字段映射的兼容性（TR-R9）：来源与目标类型相同；选项类要求选项 value 集合相同（与顺序无关）。 */
export function mappingCompatibility(source: MappingFieldShape, target: MappingFieldShape): MappingProblem | null {
  if (source.kind !== target.kind) return 'MAPPING_KIND_MISMATCH';
  if (source.kind === 'option' || source.kind === 'multi_option') {
    const left = new Set(source.optionValues);
    const same = left.size === target.optionValues.length && target.optionValues.every((value) => left.has(value));
    if (!same) return 'MAPPING_OPTIONS_MISMATCH';
  }
  return null;
}
