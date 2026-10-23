import { PART_TIME_EXPIRING_DAYS } from '@italent/domain';
import { m } from './messages.js';
export const object = 'TenantBase.EmploymentRecord';
export const personObject = 'TenantBase.Employee';
export const apiRoot = '/api/tenant/employment';
export const views = (['ongoing', 'expiring', 'not_started', 'ended', 'all', 'in_approval'] as const).map((key) => ({
  key,
  label: m.viewLabels[key],
}));
export type View = (typeof views)[number]['key'];
export interface Row {
  id: string;
  employee?: { name?: string; code?: string };
  fields?: Record<string, unknown>;
  partTimeView?: readonly string[];
  terms?: Term[];
  requests?: Row[];
  primary?: { fields?: Record<string, unknown> } | null;
  [key: string]: unknown;
}
export interface Term {
  termNo: number;
  endDate?: string | null;
  source?: string;
  createdAt?: string;
  requestId?: string;
  previous?: { termNo: number; endDate: string | null } | null;
}
export interface ListResult {
  items: Row[];
  total?: number;
  page: number;
  pageSize: number;
  hasDataPermission?: boolean;
}
export type Filters = Partial<
  Record<
    | 'keyword'
    | 'departmentId'
    | 'includeChildren'
    | 'serviceType'
    | 'startFrom'
    | 'startTo'
    | 'endFrom'
    | 'endTo'
    | 'directManagerId'
    | 'postId'
    | 'current',
    string
  >
> &
  Partial<
    Record<
      'employeeIds' | 'serviceTypes' | 'serviceStatuses' | 'pendingStatuses' | 'kinds' | 'statuses' | 'requestSources',
      string[]
    >
  >;
export type Allowed = (key: keyof Filters) => boolean;
export type SortKey =
  | 'code'
  | 'serviceType'
  | 'effectiveDate'
  | 'endDate'
  | 'departmentId'
  | 'institutionId'
  | 'directManagerId'
  | 'postId';
export interface Sort {
  sortBy: SortKey;
  direction: 'asc' | 'desc';
}
export function sortable(view: View, key: string): key is SortKey {
  if (key === 'code') return view !== 'in_approval';
  if (key === 'directManagerId') return view === 'not_started' || view === 'in_approval';
  if (key === 'postId') return view === 'in_approval';
  return ['serviceType', 'effectiveDate', 'endDate', 'departmentId', 'institutionId'].includes(key);
}
const base = [
  'name',
  'code',
  'serviceType',
  'effectiveDate',
  'institutionId',
  'departmentId',
  'directManagerId',
  'postId',
  'endDate',
];
export function columnKeys(view: View): string[] {
  switch (view) {
    case 'ongoing':
      return [...base, 'serviceStatus', 'approvalStatus', 'positionId', 'levelId'];
    case 'expiring':
      return [...base, 'serviceStatus', 'pendingStatus', 'pendingKind'];
    case 'not_started':
      return [...base, 'serviceStatus', 'approvalStatus'];
    case 'ended':
      return [...base, 'serviceStatus'];
    case 'all':
      return [...base, 'current', 'serviceStatus', 'approvalStatus'];
    case 'in_approval':
      return [...base.slice(0, 2), 'kind', ...base.slice(2), 'approvalStatus'];
  }
}
// F234B B5：保留取证列宽；机构按 F255A 保存时固化。
export function columnWidth(view: View, key: string): number {
  if (key === 'operation') return view === 'ended' ? 84 : 164;
  const date = ['effectiveDate', 'endDate'].includes(key);
  if (view === 'not_started') {
    if (date) return 112.73;
    if (key === 'directManagerId') return 137.73;
    return ['name', 'serviceStatus', 'approvalStatus'].includes(key) ? 99.73 : 147.73;
  }
  if (view === 'ended') {
    if (date) return 135.5;
    if (key === 'directManagerId') return 160.5;
    return ['name', 'serviceType', 'serviceStatus'].includes(key) ? 122.5 : 170.5;
  }
  if (view === 'expiring' && ['name', 'serviceStatus'].includes(key)) return 92;
  if (key === 'pendingStatus') return 172;
  if (date) return 105;
  return key === 'directManagerId' ? 130 : 140;
}

export function value(input: unknown): string {
  if (input === undefined || input === null || input === '') return m.missing;
  if (typeof input === 'boolean') return input ? m.yes : m.no;
  return typeof input === 'string' || typeof input === 'number' ? String(input) : m.missing;
}
export function cellValue(row: Row, key: string, view: View): string {
  if (key === 'institution') return value(row.institutionId);
  if (key === 'pendingStatus') return m.statuses[String(row.pendingStatus)] ?? value(row.pendingStatus);
  if (key === 'pendingKind') return m.kinds[String(row.pendingKind)] ?? value(row.pendingKind);
  if (key === 'name' || key === 'code') return value(row.employee?.[key]);
  if (key === 'current') {
    if (!row.partTimeView) return m.missing;
    return row.partTimeView.includes('ongoing') ? m.yes : m.no;
  }
  if (key === 'approvalStatus')
    return view === 'in_approval' ? (m.statuses[String(row.status)] ?? value(row.status)) : m.statuses.effective!;
  if (key === 'serviceType') return m.serviceTypes[String(row.serviceType)] ?? value(row.serviceType);
  if (key === 'kind') return m.kinds[String(row.kind)] ?? value(row.kind);
  if (key === 'serviceStatus') return m.serviceStatuses[String(row.serviceStatus)] ?? value(row.serviceStatus);
  return value(row[key] ?? row.fields?.[key]);
}
export function rangeInvalid(filters: Filters): boolean {
  return !!(
    (filters.startFrom && filters.startTo && filters.startFrom > filters.startTo) ||
    (filters.endFrom && filters.endTo && filters.endFrom > filters.endTo)
  );
}
const dateDistance = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;

export function filterError(view: View, filters: Filters, today?: string): string | undefined {
  if (rangeInvalid(filters)) return m.rangeInvalid;
  if (view !== 'expiring' || (!filters.endFrom && !filters.endTo)) return;
  if (!today) return m.todayUnavailable;
  if ([filters.endFrom, filters.endTo].some((date) => date && dateDistance(today, date) > PART_TIME_EXPIRING_DAYS.max))
    return m.expiringRangeInvalid;
}

/** R2-T05 §6.1 / F234B D14：日期右端换算现有 days 契约，保留显式区间与视图窗口的交集。 */
function expiringDays(filters: Filters, days: number, today?: string) {
  if (!today || !filters.endTo) return days;
  return Math.max(PART_TIME_EXPIRING_DAYS.min, dateDistance(today, filters.endTo));
}
// 对齐 routes.ts 的视图专属参数，字段权限与视图限制同时成立才可进入请求。
const filterViews: Partial<Record<keyof Filters, View>> = {
  serviceStatuses: 'all',
  current: 'all',
  pendingStatuses: 'expiring',
  kinds: 'in_approval',
  statuses: 'in_approval',
  requestSources: 'in_approval',
};
export function allowedFilters(filters: Filters, allowed: Allowed, view?: View): Filters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key, val]) => {
      const field = key as keyof Filters;
      return val?.length && allowed(field) && (!view || !filterViews[field] || filterViews[field] === view);
    }),
  );
}
export function listPath(
  view: View = 'ongoing',
  page = 1,
  filters: Filters = {},
  days = 30,
  sort?: Sort,
  today?: string,
): string {
  const query = new URLSearchParams({ view, page: String(page), pageSize: '30' });
  if (view === 'expiring') query.set('days', String(expiringDays(filters, days, today)));
  for (const [key, input] of Object.entries(allowedFilters(filters, () => true, view))) {
    if (input && (key !== 'includeChildren' || filters.departmentId)) {
      if (Array.isArray(input)) input.forEach((value) => query.append(key, value));
      else query.set(key, input);
    }
  }
  if (sort) {
    query.set('sortBy', sort.sortBy);
    query.set('direction', sort.direction);
  }
  return `${apiRoot}/part-times?${query}`;
}
