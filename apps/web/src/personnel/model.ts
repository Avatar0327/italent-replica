import type { PageRequest } from '../foundation/client.js';
import { m } from './messages.js';

export type Row = { id: string; [field: string]: unknown };
export type Filters = { name?: string; code?: string; entryDate?: string; employeeStatus?: string };
export const defaultColumns = ['name', 'code', 'gender', 'employeeStatus', 'entryDate', 'firstEntryDate', 'email'];
export const columnChoices = [...defaultColumns, 'educationLevel', 'lastSchool', 'mobilePhone', 'latestEntryDate'];
export function visibleColumns(selected: readonly string[], allowed: readonly string[]) {
  return selected.filter((key) => allowed.includes(key));
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
export function recordPeriod(row: { effectiveDate?: unknown; stopDate?: unknown }) {
  const until = row.stopDate === '9999-12-31' ? m.unbounded : displayValue(row.stopDate);
  return `${displayValue(row.effectiveDate)} → ${until}`;
}
