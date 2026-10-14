import type { PageRequest } from '../foundation/client.js';
import { m } from './messages.js';

export type Row = { id: string; [field: string]: unknown };
export type Filters = { name?: string; code?: string; entryDate?: string; employeeStatus?: string };
export const defaultColumns = ['name', 'code', 'gender', 'employeeStatus', 'entryDate', 'firstEntryDate', 'email'];
export const columnChoices = [...defaultColumns, 'educationLevel', 'lastSchool', 'mobilePhone', 'latestEntryDate'];
/** 员工姓名是列表打开档案的入口，原站在“设置显示字段”里锁定首位，不可取消、不可拖动。 */
export const lockedColumn = 'name';
export function visibleColumns(selected: readonly string[], allowed: readonly string[]) {
  return selected.filter((key) => allowed.includes(key));
}
/** 原站“设置显示字段”：新勾选的字段排到已选末尾，顺序由右栏拖拽决定。 */
export function toggleColumn(selected: readonly string[], key: string, checked: boolean): string[] {
  if (key === lockedColumn || !columnChoices.includes(key)) return [...selected];
  if (!checked) return selected.filter((item) => item !== key);
  return selected.includes(key) ? [...selected] : [...selected, key];
}
export function toggleColumnGroup(selected: readonly string[], keys: readonly string[], checked: boolean): string[] {
  if (!checked) return selected.filter((key) => key === lockedColumn || !keys.includes(key));
  return [...selected, ...keys.filter((key) => !selected.includes(key) && columnChoices.includes(key))];
}
export function columnGroupState(selected: readonly string[], keys: readonly string[]) {
  const optional = keys.filter((key) => key !== lockedColumn);
  const count = optional.filter((key) => selected.includes(key)).length;
  return { checked: count > 0 && count === optional.length, indeterminate: count > 0 && count < optional.length };
}
/** 拖到目标项的位置；员工姓名固定首位，其他字段不能越过它。 */
export function moveColumn(selected: readonly string[], key: string, target: string): string[] {
  const from = selected.indexOf(key);
  const to = selected.indexOf(target);
  if (key === lockedColumn || from < 0 || to < 0 || from === to) return [...selected];
  const next = selected.filter((item) => item !== key);
  const floor = next[0] === lockedColumn ? 1 : 0;
  next.splice(Math.max(to, floor), 0, key);
  return next;
}
export function restoreDefaultColumns() {
  return [...defaultColumns];
}
export function matchColumns(keys: readonly string[], keyword: string) {
  const text = keyword.trim();
  return text ? keys.filter((key) => (m.labels[key] ?? '').includes(text)) : [...keys];
}
export function employeeQuery(filters: Filters, page: PageRequest, allowed: readonly string[]) {
  const params = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) });
  for (const key of ['name', 'code', 'entryDate', 'employeeStatus'] as const) {
    const value = filters[key]?.trim();
    if (value && allowed.includes(key)) params.set(key === 'name' ? 'employeeName' : key, value);
  }
  return params.toString();
}
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return m.empty;
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return m.empty;
}
export function fieldValue(key: string, value: unknown) {
  if (key === 'employeeStatus' && typeof value === 'number') return m.statuses[value] ?? displayValue(value);
  return displayValue(value);
}
/** 原站任职记录卡片写“开始 至 结束”，无截止日期（9999-12-31）写“至今”。 */
export function recordPeriod(row: { effectiveDate?: unknown; stopDate?: unknown }) {
  const from = displayValue(row.effectiveDate);
  return row.stopDate === '9999-12-31' ? `${from} ${m.untilNow}` : `${from} ${m.until} ${displayValue(row.stopDate)}`;
}
