/**
 * AC-EV-01 跨级纯函数（R3-T02 设计 §7.1 第 4 条、P2-06；Q-T02-06 先按设计推荐实现 🟡，DEC-334②；拆分方案 B2）。
 * 跨过的级数 = rank(申请级别) − rank(原级别) − 1；rank 是级别在有序序列（按顺序号升序）里的位置，不直接用顺序号相减。
 * 推荐口径：序列 = 申请类别标准的级别范围；原级别为空视为最低级的前一级；原级别不在序列里 → LEVEL_JUMP_UNDETERMINED；
 * 申请不高于原级别允许。
 */
import { checkLevelJump, defaultApplyLevelId, type LevelOrderRef } from '@italent/domain';
import { describe, expect, it } from 'vitest';

const sequence = (orders: readonly number[]): LevelOrderRef[] =>
  orders.map((displayOrder, index) => ({ id: `P${index + 3}`, displayOrder }));

// P3 → P6 四个级别；顺序号连续与不连续（10 / 20 / 40）必须同结果
const SEQUENCES = {
  连续: sequence([1, 2, 3, 4]),
  不连续: sequence([10, 20, 30, 40]),
  跳号: sequence([10, 20, 40, 90]),
};

describe.each(Object.entries(SEQUENCES))('AC-EV-01 原 P3、最多跨 1 级（顺序号%s）', (_label, levels) => {
  const check = (apply: string) =>
    checkLevelJump({ levels, originalLevelId: 'P3', applyLevelId: apply, maxLevelJump: 1 });

  it('P4 跨 0 级、P5 跨 1 级允许', () => {
    expect(check('P4')).toEqual({ ok: true, crossedLevels: 0 });
    expect(check('P5')).toEqual({ ok: true, crossedLevels: 1 });
  });

  it('P6 跨 2 级拒绝 LEVEL_JUMP_EXCEEDED，并带回跨过的级数', () => {
    expect(check('P6')).toEqual({ ok: false, code: 'LEVEL_JUMP_EXCEEDED', crossedLevels: 2 });
  });

  it('默认申请 = 原级别的下一级', () => {
    expect(defaultApplyLevelId(levels, 'P3')).toBe('P4');
  });
});

describe('AC-EV-01 序列顺序与输入顺序无关', () => {
  it('输入乱序时仍按顺序号升序编号', () => {
    const shuffled = [SEQUENCES.不连续[3]!, SEQUENCES.不连续[0]!, SEQUENCES.不连续[2]!, SEQUENCES.不连续[1]!];
    expect(checkLevelJump({ levels: shuffled, originalLevelId: 'P3', applyLevelId: 'P5', maxLevelJump: 1 })).toEqual({
      ok: true,
      crossedLevels: 1,
    });
  });
});

describe('AC-EV-01 Q-T02-06 边界（设计推荐 🟡）', () => {
  const levels = SEQUENCES.不连续;

  it('原级别为空 = 序列最低级的前一级：申请最低级跨 0 级、第二级跨 1 级', () => {
    expect(checkLevelJump({ levels, originalLevelId: null, applyLevelId: 'P3', maxLevelJump: 0 })).toEqual({
      ok: true,
      crossedLevels: 0,
    });
    expect(checkLevelJump({ levels, originalLevelId: null, applyLevelId: 'P4', maxLevelJump: 0 })).toEqual({
      ok: false,
      code: 'LEVEL_JUMP_EXCEEDED',
      crossedLevels: 1,
    });
    expect(defaultApplyLevelId(levels, null)).toBe('P3');
  });

  it('原级别不在序列里 → LEVEL_JUMP_UNDETERMINED（不猜）', () => {
    const result = checkLevelJump({ levels, originalLevelId: 'X9', applyLevelId: 'P4', maxLevelJump: 5 });
    expect(result).toEqual({ ok: false, code: 'LEVEL_JUMP_UNDETERMINED' });
    expect(defaultApplyLevelId(levels, 'X9')).toBeNull();
  });

  it('申请级别不在序列里 → LEVEL_JUMP_UNDETERMINED', () => {
    expect(checkLevelJump({ levels, originalLevelId: 'P3', applyLevelId: 'X9', maxLevelJump: 5 })).toEqual({
      ok: false,
      code: 'LEVEL_JUMP_UNDETERMINED',
    });
  });

  it('申请不高于原级别允许，不算负数的跨级', () => {
    expect(checkLevelJump({ levels, originalLevelId: 'P5', applyLevelId: 'P5', maxLevelJump: 0 })).toEqual({
      ok: true,
      crossedLevels: 0,
    });
    expect(checkLevelJump({ levels, originalLevelId: 'P5', applyLevelId: 'P3', maxLevelJump: 0 })).toEqual({
      ok: true,
      crossedLevels: 0,
    });
  });

  it('原级别已是最高级时没有默认申请级别', () => {
    expect(defaultApplyLevelId(levels, 'P6')).toBeNull();
  });

  it('序列为空 → LEVEL_JUMP_UNDETERMINED', () => {
    expect(checkLevelJump({ levels: [], originalLevelId: null, applyLevelId: 'P3', maxLevelJump: 1 })).toEqual({
      ok: false,
      code: 'LEVEL_JUMP_UNDETERMINED',
    });
  });

  it.each([-1, 1.5, Number.NaN])('最大跨级数 %s 不合法 → MAX_LEVEL_JUMP_INVALID', (bad) => {
    expect(checkLevelJump({ levels, originalLevelId: 'P3', applyLevelId: 'P4', maxLevelJump: bad })).toEqual({
      ok: false,
      code: 'MAX_LEVEL_JUMP_INVALID',
    });
  });
});
