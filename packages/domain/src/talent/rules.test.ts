import { describe, expect, it } from 'vitest';
import { criterionDimensionValues, criterionDimensionViolation, type ReferencedDimension } from './rules.js';

const dim = (id: string, type: ReferencedDimension['type'], enabled = true, libraryEnabled = true) =>
  [id, { id, type, enabled, libraryEnabled }] as const;
const referenced = new Map([
  dim('a', 'ability'),
  dim('p', 'potential'),
  dim('e', 'experience'),
  dim('off', 'ability', false),
  dim('libOff', 'ability', true, false),
]);

describe('人才标准引用指标规则（23 §2.2）', () => {
  it('TC-R3 只有能力指标可设权重与目标；权重 0 也算设置', () => {
    expect(criterionDimensionViolation([{ dimensionId: 'a', weight: 30, target: 2 }], referenced, new Set())).toBe(
      null,
    );
    for (const item of [
      { dimensionId: 'p', weight: 10 },
      { dimensionId: 'e', target: 1 },
      { dimensionId: 'p', weight: 0 },
    ]) {
      expect(criterionDimensionViolation([item], referenced, new Set())).toEqual({
        reason: 'WEIGHT_TARGET_ABILITY_ONLY',
        dimensionId: item.dimensionId,
      });
    }
    expect(criterionDimensionViolation([{ dimensionId: 'p', weight: null, target: null }], referenced, new Set())).toBe(
      null,
    );
  });

  it('TC-R4 新引用的指标与指标库都须已启用；已有引用不受停用影响', () => {
    expect(criterionDimensionViolation([{ dimensionId: 'off' }], referenced, new Set())).toEqual({
      reason: 'DIMENSION_NOT_ENABLED',
      dimensionId: 'off',
    });
    expect(criterionDimensionViolation([{ dimensionId: 'libOff' }], referenced, new Set())).toEqual({
      reason: 'DIMENSION_NOT_ENABLED',
      dimensionId: 'libOff',
    });
    expect(criterionDimensionViolation([{ dimensionId: 'off', weight: 5 }], referenced, new Set(['off']))).toBe(null);
  });

  it('同一标准内不能重复引用同一指标', () => {
    expect(criterionDimensionViolation([{ dimensionId: 'a' }, { dimensionId: 'a' }], referenced, new Set())).toEqual({
      reason: 'DUPLICATE_DIMENSION',
      dimensionId: 'a',
    });
  });
});

describe('引用行的权重与目标取值（DEC-281②）', () => {
  it('新增的能力指标引用缺省权重 1；潜力 / 经历不套用缺省；显式 null 保持为空', () => {
    expect(
      criterionDimensionValues(
        [{ dimensionId: 'a' }, { dimensionId: 'p' }, { dimensionId: 'off', weight: null, target: -2.5 }],
        referenced,
        new Map(),
      ),
    ).toEqual([
      { dimensionId: 'a', weight: 1, target: null },
      { dimensionId: 'p', weight: null, target: null },
      { dimensionId: 'off', weight: null, target: -2.5 },
    ]);
  });

  it('已有引用没传权重 / 目标时保持原值，传了就用新值', () => {
    const existing = new Map([['a', { weight: 40, target: 3 }]]);
    expect(criterionDimensionValues([{ dimensionId: 'a' }], referenced, existing)).toEqual([
      { dimensionId: 'a', weight: 40, target: 3 },
    ]);
    expect(criterionDimensionValues([{ dimensionId: 'a', weight: 2.5, target: null }], referenced, existing)).toEqual([
      { dimensionId: 'a', weight: 2.5, target: null },
    ]);
  });
});
