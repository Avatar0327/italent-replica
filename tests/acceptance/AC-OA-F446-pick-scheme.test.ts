/**
 * F-446：预览编制原值的多方案兜底 `pickScheme`（纯函数）。
 * 北森同一组织同一期间只会有一个方案的编制，跨年方案按生效日所在周期区分（见 AC-OA-44-export 的跨年用例）；
 * 复刻写入侧尚未拦跨方案重叠周期（F-037），所以兜底保持确定性：排除已停用 → 默认方案优先 → 编码升序，与录入顺序无关。
 */
import { describe, expect, it } from 'vitest';
import { pickScheme } from '../../apps/api/src/modules/org-adjustment/preview.js';

const scheme = (code: string, enabled = true) => ({ code, enabled });

/** 全部排列：每种录入顺序结果都必须相同。 */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('AC-OA-F446 pickScheme 兜底口径', () => {
  it('没有候选或全部已停用 → null（显示“--”）', () => {
    expect(pickScheme([])).toBeNull();
    expect(pickScheme([scheme('A', false), scheme('DEFAULT', false)])).toBeNull();
  });

  it('已停用方案一律排除：编码最小的停用方案、已停用的 DEFAULT 都不能胜出', () => {
    for (const list of permutations([scheme('A01', false), scheme('DEFAULT', false), scheme('B02'), scheme('C03')])) {
      expect(pickScheme(list)).toEqual(scheme('B02'));
    }
  });

  it('启用方案里 DEFAULT 优先（即使编码更大、先后录入都一样）', () => {
    for (const list of permutations([scheme('A01'), scheme('B02'), scheme('DEFAULT')])) {
      expect(pickScheme(list)).toEqual(scheme('DEFAULT'));
    }
  });

  it('其余按编码升序取第一个，按码元比较（大写先于小写），与录入顺序无关', () => {
    for (const list of permutations([scheme('b'), scheme('B'), scheme('a')])) {
      expect(pickScheme(list)).toEqual(scheme('B'));
    }
    for (const list of permutations([scheme('ZZ_C'), scheme('ZZ_D'), scheme('ZZ_E')])) {
      expect(pickScheme(list)).toEqual(scheme('ZZ_C'));
    }
  });

  it('不改传入的数组；候选携带的其它字段原样返回', () => {
    const input = [
      { ...scheme('B'), id: 'x' },
      { ...scheme('A'), id: 'y' },
    ];
    const snapshot = structuredClone(input);
    expect(pickScheme(input)).toBe(input[1]);
    expect(input).toEqual(snapshot);
  });
});
