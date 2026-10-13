export const validateDates = (start?: string | null, end?: string | null) => !start || !end || start <= end;
export function evaluationActions(row: { status?: string; applyCount?: number }): ('publish' | 'unpublish')[] {
  if (row.status === 'draft') return ['publish'];
  return row.status === 'published' && row.applyCount === 0 ? ['unpublish'] : [];
}
export function evaluationPatch(before: Record<string, unknown>, values: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => fields.includes(key) && JSON.stringify(value) !== JSON.stringify(before[key]),
    ),
  );
}
export interface Row extends Record<string, unknown> {
  id: string;
  revision: number;
  name?: string;
  status?: string;
}
export const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
