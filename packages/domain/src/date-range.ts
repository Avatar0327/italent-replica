/**
 * 左闭右开的日期区间 [start, end)，与 PostgreSQL daterange 的规范形式一致。
 * end 为 null 表示无上界（长期有效）。日期用 ISO 格式字符串 YYYY-MM-DD，按业务日期（租户时区）解释。
 */
export interface DateRange {
  readonly start: string;
  readonly end: string | null;
}

/** 两个区间是否重叠；对应数据库侧 `valid_during && other` 的语义。 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const aEndsAfterBStarts = a.end === null || a.end > b.start;
  const bEndsAfterAStarts = b.end === null || b.end > a.start;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}
