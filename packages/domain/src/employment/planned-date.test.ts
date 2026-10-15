import { describe, expect, it } from 'vitest';
import { resolvePlannedEffectiveDate, type PlanVersion } from './planned-date.js';

const manual = (versionNo: number, effectiveDate: string): PlanVersion => ({ versionNo, effectiveDate, manual: true });
const derived = (versionNo: number, effectiveDate: string): PlanVersion => ({
  versionNo,
  effectiveDate,
  manual: false,
});

describe('F-140 计划生效日纯函数（约束 1 / 2）', () => {
  it('没有版本时取回退值', () => {
    expect(resolvePlannedEffectiveDate({ versions: [], fallback: '2026-10-01' })).toBe('2026-10-01');
  });

  it('系统顺延只改实际执行日，计划沿用最后一次人工日期', () => {
    const versions = [manual(1, '2026-10-20'), derived(2, '2026-11-01'), derived(3, '2026-11-02')];
    expect(resolvePlannedEffectiveDate({ versions, fallback: '2026-01-01' })).toBe('2026-10-20');
  });

  it('第 7 轮自构①：人工 11-10 → 10-20 后同事务顺延到 11-01，计划为 10-20', () => {
    const versions = [manual(1, '2026-11-10'), manual(2, '2026-10-20'), derived(3, '2026-11-01')];
    expect(resolvePlannedEffectiveDate({ versions, fallback: '2026-01-01' })).toBe('2026-10-20');
  });

  it('第 6 轮原反例与两次改期：取最后一次人工日期', () => {
    expect(
      resolvePlannedEffectiveDate({ versions: [manual(1, '2026-10-16'), manual(2, '2026-10-30')], fallback: 'x' }),
    ).toBe('2026-10-30');
    const twice = [manual(1, '2026-10-16'), manual(2, '2026-10-30'), manual(3, '2026-10-25')];
    expect(resolvePlannedEffectiveDate({ versions: twice, fallback: 'x' })).toBe('2026-10-25');
  });

  it('先顺延、再人工改期：新的人工日期取代旧计划，之后的顺延不再改变它', () => {
    const versions = [
      manual(1, '2026-10-16'),
      derived(2, '2026-10-18'),
      manual(3, '2026-10-26'),
      derived(4, '2026-11-05'),
    ];
    expect(resolvePlannedEffectiveDate({ versions, fallback: 'x' })).toBe('2026-10-26');
  });

  it('首版即使由系统写出也以其日期为计划', () => {
    expect(resolvePlannedEffectiveDate({ versions: [derived(1, '2026-10-09')], fallback: 'x' })).toBe('2026-10-09');
  });

  it('只按版本序号判断先后：输入顺序任意打乱，结果不变', () => {
    const versions = [manual(1, '2026-11-10'), manual(2, '2026-10-20'), derived(3, '2026-11-01')];
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of permutations)
      expect(
        resolvePlannedEffectiveDate({ versions: order.map((index) => versions[index]!), fallback: 'x' }),
        order.join(','),
      ).toBe('2026-10-20');
  });

  it('版本序号重复视为数据损坏，拒绝而不是任选一条', () => {
    expect(() =>
      resolvePlannedEffectiveDate({ versions: [manual(1, '2026-10-20'), derived(1, '2026-11-01')], fallback: 'x' }),
    ).toThrow(RangeError);
  });
});
