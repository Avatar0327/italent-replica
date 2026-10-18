import { describe, expect, it } from 'vitest';
import type { InfoRow } from '../../apps/web/src/idp/info-model.js';
import { sortLevels } from '../../apps/web/src/idp/info-references.js';

const categories: InfoRow[] = ['A', 'B', 'C'].map((id) => ({ id, enabled: id !== 'B' }));
const row = (id: string, levelTypeId: string | null, level: number): InfoRow => ({ id, levelTypeId, level });
const ids = (rows: InfoRow[]) => rows.map((r) => r.id);
function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
  );
}

describe('AC-FE-F185 职级统一排序', () => {
  it('AC-FE-F185-17 空10 / A / 空1 按类别分组、空类别组内按数值升序', () => {
    const rows = [row('空10', null, 10), row('A1', 'A', 1), row('空1', null, 1)];
    expect(ids(sortLevels(rows, categories))).toEqual(['A1', '空1', '空10']);
  });

  it('AC-FE-F185-18 混合类别的全部 720 种排列得到一致分组与组内顺序，裁剪项原位保留', () => {
    const visible = [
      row('C1', 'C', 1),
      row('空10', null, 10),
      row('A10', 'A', 10),
      row('B1', 'B', 1),
      row('空1', null, 1),
      row('A1', 'A', 1),
    ];
    const hiddenType: InfoRow = { id: '裁剪类别', level: 9 };
    const hiddenLevel: InfoRow = { id: '裁剪级别', levelTypeId: 'A' };
    const hiddenCategory = row('类别不在授权结果中', 'outside', 1);
    for (const sequence of permutations(visible)) {
      const rows = [...sequence];
      rows.splice(1, 0, hiddenType);
      rows.splice(4, 0, hiddenLevel);
      rows.splice(7, 0, hiddenCategory);
      const expected = ['A1', hiddenType.id, 'A10', 'B1', hiddenLevel.id, 'C1', '空1', hiddenCategory.id, '空10'];
      const sorted = sortLevels(rows, categories);
      expect(ids(sorted)).toEqual(expected);
      expect(sorted[1]).toBe(hiddenType);
      expect(sorted[4]).toBe(hiddenLevel);
      expect(sorted[7]).toBe(hiddenCategory);
      expect(ids(sortLevels(sorted, categories))).toEqual(expected);
    }
  });

  it('AC-FE-F185-19 类别与级别相同时沿用接口返回顺序作为稳定后备键', () => {
    const rows = [row('空甲', null, 1), row('A甲', 'A', 1), row('空乙', null, 1), row('A乙', 'A', 1)];
    expect(ids(sortLevels(rows, categories))).toEqual(['A甲', 'A乙', '空甲', '空乙']);
  });
});
