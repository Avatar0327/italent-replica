import { describe, expect, it } from 'vitest';
import { criterionDimensionViolation, type ReferencedDimension } from './rules.js';

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
