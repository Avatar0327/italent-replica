import { ApiError } from '../foundation/client.js';
import type { ProjectAction, ReviewRecord } from './types.js';
import { tr } from './messages.js';
export function projectActions(row: ReviewRecord, can: (button: string) => boolean): ProjectAction[] {
  if (row.accessLevel !== 'manage' || !Number.isInteger(row.revision)) return [];
  const actions: Record<string, ProjectAction[]> = {
    new: ['update', 'start', 'end'],
    in_progress: ['update', 'end'],
    ended: ['restart'],
  };
  return (actions[row.status ?? ''] ?? []).filter((button) => can(button));
}
const writable = [
  'code',
  'name',
  'ownerOrgId',
  'year',
  'period',
  'periodStartDate',
  'periodEndDate',
  'businessDate',
  'categoryId',
  'criterionId',
  'calcRuleId',
  'downwardPublic',
  'carryLastResult',
  'sharedOrgIds',
];
export function projectInput(
  values: Record<string, unknown>,
  editable: string[],
  initial: Record<string, unknown> = {},
) {
  const body: Record<string, unknown> = {};
  for (const key of writable) {
    if (!editable.includes(key) || !(key in values)) continue;
    let value = values[key];
    if (typeof value === 'string') value = value.trim();
    if (key.endsWith('Id') && typeof value === 'string') value = value.toLowerCase();
    if (['categoryId', 'criterionId', 'calcRuleId', 'businessDate'].includes(key) && !value) value = null;
    body[key] = value;
  }
  const start = body.periodStartDate ?? initial.periodStartDate;
  const end = body.periodEndDate ?? initial.periodEndDate;
  if (typeof start === 'string' && typeof end === 'string' && start > end)
    throw new ApiError(422, 'VALIDATION_FAILED', 'fields', tr.dateOrder, {
      details: { fieldErrors: { periodEndDate: [tr.dateOrder] } },
    });
  return body;
}
export function filterProjects(rows: ReviewRecord[], view: string, name: string) {
  return rows.filter(
    (row) =>
      (view === 'all' ||
        (view === 'ended' ? row.status === 'ended' : ['new', 'in_progress'].includes(row.status ?? ''))) &&
      (!name || row.name?.includes(name.trim())),
  );
}
export function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return tr.missing;
  if (typeof value === 'boolean') return value ? tr.yes : tr.no;
  return String(value);
}

export interface ReviewFilters {
  name?: string;
  ownerOrgId?: string;
  year?: number | null;
  startFrom?: string | null;
  startTo?: string | null;
  endFrom?: string | null;
  endTo?: string | null;
}
export function matchesFilters(row: ReviewRecord, filters: ReviewFilters, visible: (field: string) => boolean) {
  if (visible('name') && filters.name && !row.name?.includes(filters.name.trim())) return false;
  if (visible('ownerOrgId') && filters.ownerOrgId && row.ownerOrgId !== filters.ownerOrgId) return false;
  if (visible('year') && filters.year !== null && filters.year !== undefined && row.year !== filters.year) return false;
  for (const [field, from, to] of [
    ['periodStartDate', filters.startFrom, filters.startTo],
    ['periodEndDate', filters.endFrom, filters.endTo],
  ] as const) {
    if (!visible(field) || (!from && !to)) continue;
    const date = row[field];
    if (!date || (from && date < from) || (to && date > to)) return false;
  }
  return true;
}
