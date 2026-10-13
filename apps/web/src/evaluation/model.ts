import { validateActivityConditionDetails, type ActivityConditionDetailInput } from '@italent/domain';
import { m } from './messages.js';
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
export function insertActivityChain<T extends { type?: unknown }>(current: T[], chain: T): T[] {
  const end = current.findIndex((item) => item.type === 'result');
  return end < 0 ? [...current, chain] : [...current.slice(0, end), chain, ...current.slice(end)];
}

/** 保留接口的数字 / 文本类型，不把看起来像数字的文本擅自转换成数字。 */
export function validateConditions(value: unknown): void {
  for (const condition of records(value)) {
    const details = records(condition.details);
    for (const detail of details) {
      if (
        detail.operator === 'between' &&
        detail.value1 !== null &&
        detail.value1 !== undefined &&
        detail.value2 !== null &&
        detail.value2 !== undefined &&
        typeof detail.value1 !== typeof detail.value2
      )
        throw new Error(m.conditionTypeInvalid);
    }
    const result = validateActivityConditionDetails(details as unknown as ActivityConditionDetailInput[]);
    if (!result.ok)
      throw new Error(
        result.issues.some((issue) => issue.code === 'RANGE_INVERTED') ? m.conditionRangeInvalid : m.conditionInvalid,
      );
  }
}
