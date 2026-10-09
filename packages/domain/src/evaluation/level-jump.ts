/**
 * 跨级计算纯函数（R3-T02 设计 §7.1 第 4 条、P2-06；拆分方案 B2）。
 * 跨过的级数 = rank(申请级别) − rank(原级别) − 1；rank 是级别在有序级别序列里的位置（按顺序号升序后编号 1、2、3…），
 * 不直接用顺序号相减，所以顺序号 10 / 20 / 40 与 1 / 2 / 3 同结果。
 * Q-T02-06 先按设计推荐实现 🟡（DEC-334②），取证后再核对：
 * - 序列 = 申请类别标准的级别范围（由调用方传入）；
 * - 原级别为空 = 序列最低级的前一级（rank 0）；
 * - 原级别（或申请级别）不在序列里 = LEVEL_JUMP_UNDETERMINED，不猜；
 * - 申请不高于原级别允许，跨过的级数记 0。
 */
export interface LevelOrderRef {
  readonly id: string;
  readonly displayOrder: number;
}

export type LevelJumpResult =
  | { readonly ok: true; readonly crossedLevels: number }
  | { readonly ok: false; readonly code: 'LEVEL_JUMP_EXCEEDED'; readonly crossedLevels: number }
  | { readonly ok: false; readonly code: 'LEVEL_JUMP_UNDETERMINED' | 'MAX_LEVEL_JUMP_INVALID' };

export interface LevelJumpInput {
  /** 有序序列的成员（顺序不限，函数按顺序号升序编号）。 */
  readonly levels: readonly LevelOrderRef[];
  /** 员工原级别；空 = 没有当前资格。 */
  readonly originalLevelId: string | null;
  readonly applyLevelId: string;
  /** 活动的 max_level_jump：最多可跨过的级数。 */
  readonly maxLevelJump: number;
}

/** 级别 ID → 位置（从 1 起）；顺序号相同的按 ID 排，保证结果与输入顺序无关。 */
function rankOf(levels: readonly LevelOrderRef[]): ReadonlyMap<string, number> {
  const ordered = [...levels].sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  return new Map(ordered.map((level, index) => [level.id, index + 1]));
}

export function checkLevelJump(input: LevelJumpInput): LevelJumpResult {
  if (!Number.isInteger(input.maxLevelJump) || input.maxLevelJump < 0) {
    return { ok: false, code: 'MAX_LEVEL_JUMP_INVALID' };
  }
  const ranks = rankOf(input.levels);
  const applyRank = ranks.get(input.applyLevelId);
  const originalRank = input.originalLevelId === null ? 0 : ranks.get(input.originalLevelId);
  if (applyRank === undefined || originalRank === undefined) return { ok: false, code: 'LEVEL_JUMP_UNDETERMINED' };
  const crossedLevels = Math.max(0, applyRank - originalRank - 1);
  if (crossedLevels > input.maxLevelJump) return { ok: false, code: 'LEVEL_JUMP_EXCEEDED', crossedLevels };
  return { ok: true, crossedLevels };
}

/** 默认申请级别 = 原级别的下一级；原级别为空取最低级；原级别不在序列里或已是最高级返回 null。 */
export function defaultApplyLevelId(levels: readonly LevelOrderRef[], originalLevelId: string | null): string | null {
  const ranks = rankOf(levels);
  const originalRank = originalLevelId === null ? 0 : ranks.get(originalLevelId);
  if (originalRank === undefined) return null;
  for (const [id, rank] of ranks) if (rank === originalRank + 1) return id;
  return null;
}
