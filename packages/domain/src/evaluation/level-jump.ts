/**
 * 跨级计算纯函数（R3-T02 设计 §7.1 第 4 条、P2-06；DEC-372 跨级口径；拆分方案 B2）。
 * max_level_jump = N 表示“最多比原级别高出 N 级”：+N 允许，+N+1 拒绝（AC-EV-01 在 EV_XL 实测：可跨 1 级时 +1 成功、
 * +2 / +3 被拒）。跨级限制**必填、只能选 1～5、没有“不限”**（DEC-372②，Q-M0-154，照原站）：空值、非整数、
 * <1 或 >5 都是配置非法（MAX_LEVEL_JUMP_INVALID），不当作不限，也不静默放行。
 * 高出的级数 = rank(申请级别) − rank(原级别)；rank 是级别在有序级别序列里的位置（按顺序号升序后编号 1、2、3…），
 * 不直接用顺序号相减，所以顺序号 10 / 20 / 40 与 1 / 2 / 3 同结果。
 * Q-T02-06 的其余边界先按设计推荐实现 🟡（DEC-334②），取证后再核对：
 * - 序列 = 申请类别标准的级别范围（由调用方传入）；
 * - 原级别为空 = 序列最低级的前一级（rank 0）；
 * - 原级别（或申请级别）不在序列里 = LEVEL_JUMP_UNDETERMINED，不猜；
 * - 申请不高于原级别允许，高出级数记 0。
 * 序列里的级别 ID 须唯一：有重复时位置失真，按“无法判定”处理（不猜哪一个是对的）。
 */
/** 活动 max_level_jump 的合法取值（Q-M0-154）：1～5 的整数，新建默认 1。 */
export const LEVEL_JUMP_LIMITS = { min: 1, max: 5, default: 1, values: [1, 2, 3, 4, 5] } as const;

export interface LevelOrderRef {
  readonly id: string;
  readonly displayOrder: number;
}

export type LevelJumpResult =
  | { readonly ok: true; readonly raisedLevels: number }
  | { readonly ok: false; readonly code: 'LEVEL_JUMP_EXCEEDED'; readonly raisedLevels: number }
  | { readonly ok: false; readonly code: 'LEVEL_JUMP_UNDETERMINED' | 'MAX_LEVEL_JUMP_INVALID' };

export interface LevelJumpInput {
  /** 有序序列的成员（顺序不限，函数按顺序号升序编号）。 */
  readonly levels: readonly LevelOrderRef[];
  /** 员工原级别；空 = 没有当前资格。 */
  readonly originalLevelId: string | null;
  readonly applyLevelId: string;
  /** 活动的 max_level_jump：最多比原级别高出的级数，1～5；其他值（含空）按配置非法处理。 */
  readonly maxLevelJump: number;
}

/** 级别 ID → 位置（从 1 起）；顺序号相同的按 ID 排，保证结果与输入顺序无关。ID 重复返回 undefined。 */
function rankOf(levels: readonly LevelOrderRef[]): ReadonlyMap<string, number> | undefined {
  if (new Set(levels.map((level) => level.id)).size !== levels.length) return undefined;
  const ordered = [...levels].sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  return new Map(ordered.map((level, index) => [level.id, index + 1]));
}

export function checkLevelJump(input: LevelJumpInput): LevelJumpResult {
  const max = input.maxLevelJump;
  const valid = Number.isInteger(max) && max >= LEVEL_JUMP_LIMITS.min && max <= LEVEL_JUMP_LIMITS.max;
  if (!valid) return { ok: false, code: 'MAX_LEVEL_JUMP_INVALID' };
  const ranks = rankOf(input.levels);
  if (!ranks) return { ok: false, code: 'LEVEL_JUMP_UNDETERMINED' };
  const applyRank = ranks.get(input.applyLevelId);
  const originalRank = input.originalLevelId === null ? 0 : ranks.get(input.originalLevelId);
  if (applyRank === undefined || originalRank === undefined) return { ok: false, code: 'LEVEL_JUMP_UNDETERMINED' };
  const raisedLevels = Math.max(0, applyRank - originalRank);
  if (raisedLevels > max) return { ok: false, code: 'LEVEL_JUMP_EXCEEDED', raisedLevels };
  return { ok: true, raisedLevels };
}

/** 默认申请级别 = 原级别的下一级；原级别为空取最低级；原级别不在序列里、序列有重复或已是最高级返回 null。 */
export function defaultApplyLevelId(levels: readonly LevelOrderRef[], originalLevelId: string | null): string | null {
  const ranks = rankOf(levels);
  const originalRank = originalLevelId === null ? 0 : ranks?.get(originalLevelId);
  if (!ranks || originalRank === undefined) return null;
  for (const [id, rank] of ranks) if (rank === originalRank + 1) return id;
  return null;
}
