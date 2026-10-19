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
    | 'directManagerId',
    string
  >
>;
export type Allowed = (key: keyof Filters) => boolean;
const base = [
  'name',
  'code',
  'serviceType',
  'effectiveDate',
  'institution',
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
// F234B B5：保留取证列宽；后补列仍占位，不拿其他字段拼出值（F-256）。
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
  if (['institution', 'pendingStatus', 'pendingKind'].includes(key)) return m.missing;
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
// 用当前字段权重投影，撤权后旧筛选草稿不能继续进入请求；不从行中缺键推断整个列表的权限。
export function allowedFilters(filters: Filters, allowed: Allowed): Filters {
  return Object.fromEntries(Object.entries(filters).filter(([key, val]) => val && allowed(key as keyof Filters)));
}
export function listPath(view: View = 'ongoing', page = 1, filters: Filters = {}, days = 30): string {
  const query = new URLSearchParams({ view, page: String(page), pageSize: '30' });
  if (view === 'expiring') query.set('days', String(days));
  for (const [key, input] of Object.entries(filters)) {
    if (input && (key !== 'includeChildren' || filters.departmentId)) query.set(key, input);
  }
  return `${apiRoot}/part-times?${query}`;
}
