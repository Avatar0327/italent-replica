import type { InfoRow } from './info-model.js';

/** #355：类别沿主数据顺序，同类别按数值级别升序；裁剪字段不参与排序。 */
export function sortLevels(rows: InfoRow[], categories: InfoRow[]) {
  const rank = new Map<string | null, number>(categories.map((row, index) => [row.id, index]));
  // 空类别固定在已知类别之后；不能用跨组返回 0 表示跳过，否则比较关系不传递。
  rank.set(null, categories.length);
  const comparable = rows.flatMap((row, index) => {
    if (row.levelTypeId !== null && typeof row.levelTypeId !== 'string') return [];
    const group = rank.get(row.levelTypeId);
    if (group === undefined || typeof row.level !== 'number' || !Number.isFinite(row.level)) return [];
    return [{ row, index, group, level: row.level }];
  });
  // 仅回填可比较项的槽位；裁剪字段或类别不在授权结果中的项留在原位置。
  const slots = comparable.map(({ index }) => index);
  // 接口已按 displayOrder 返回；相同类别 / 级别用原下标兜底，保持该顺序。
  comparable.sort((a, b) => a.group - b.group || a.level - b.level || a.index - b.index);
  slots.forEach((slot, index) => {
    rows[slot] = comparable[index]!.row;
  });
  return rows;
}
