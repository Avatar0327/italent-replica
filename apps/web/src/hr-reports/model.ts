import { codeText } from '../foundation/code-text.js';
import {
  PERSONNEL_REPORTS,
  HR_MOVEMENT_REPORTS,
  HR_STRUCTURE_REPORTS,
  HR_STRUCTURE_REPORT_EMPLOY_TYPES,
  reportCellLabel,
  rosterCellText,
  TERM_TYPE_LABELS,
  type PersonnelReport,
} from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { m } from './messages.js';
export const base = '/api/tenant/hr-analysis/reports';
export const catalogReportOf = (code: string) => PERSONNEL_REPORTS.find((r) => r.code === code);
const positionReport: PersonnelReport = {
  ...HR_STRUCTURE_REPORTS.find(({ code }) => code === 'position')!,
  endpoint: '/api/tenant/analytics/hr-structure/reports/position',
  permission: 'hrStructureReport',
  group: '人事报表',
  requires: [],
};
const flowReport: PersonnelReport = {
  ...HR_MOVEMENT_REPORTS.find(({ code }) => code === 'flow')!,
  endpoint: '/api/tenant/analytics/hr-movement/reports/flow',
  permission: 'hrMovementReport',
  group: '人事报表',
  requires: [],
};
export const structureReports = [catalogReportOf('quality')!, positionReport];
export const movementReports = [flowReport, catalogReportOf('monthly')!, catalogReportOf('institution')!];
export const reportOf = (code: string) =>
  catalogReportOf(code) ??
  structureReports.find((r) => r.code === code) ??
  movementReports.find((r) => r.code === code);
export const structureReport = (code: string) => structureReports.some((report) => report.code === code);
export const movement = (code: string) => movementReports.some((report) => report.code === code);
export const supportsStatExport = (code: string) => ['monthly', 'institution', 'quality'].includes(code);
export const statistical = (code: string) => structureReport(code) || movement(code);
export interface Column {
  key: string;
  label: string;
}
export type Row = Record<string, unknown>;
export interface RosterPage {
  columns: Column[];
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
  hasDataPermission: boolean;
  asOf?: string;
}
export interface Statistics {
  asOf?: string;
  columns: Column[];
  rows: { key?: string; label?: string; organizationId?: string; organizationName?: string; cells: Row }[];
  summary: { cells: Row };
  key?: string;
  name?: string;
}
interface MovementReportData {
  asOf: string;
  year: number;
  month: number | null;
  tables: Statistics[];
  hasDataPermission: boolean;
}
export type ReportData = RosterPage | (Statistics & { hasDataPermission: boolean }) | MovementReportData;
export interface CatalogItem extends Pick<PersonnelReport, 'code' | 'name' | 'group' | 'endpoint'> {
  available: boolean;
  reason?: string;
}
export type Filters = Record<string, string>;
export const rosterFilterColumns = {
  name: 'employeeName',
  workDateFrom: 'workDate',
  workDateTo: 'workDate',
  employeeStatus: 'employeeStatus',
} as const;

/** §4.5：列回执决定可用筛选。个人邮箱列不能授权主邮箱筛选。 */
export function rosterFilters(filters: Filters, columns: readonly Column[]): Filters {
  const result: Filters = {};
  if (filters.asOf) result.asOf = filters.asOf;
  for (const [field, column] of Object.entries(rosterFilterColumns)) {
    const value = filters[field];
    if (value && columns.some(({ key }) => key === column)) result[field] = value;
  }
  return result;
}

/** 回执时点固定本次结果。撤列且仍带该条件时，须重新查询才能分页或导出。 */
export function rosterResultFilters(
  filters: Filters,
  result: Pick<RosterPage, 'asOf' | 'columns'>,
): Filters | undefined {
  const allowed = rosterFilters(filters, result.columns);
  if (Object.entries(filters).some(([key, value]) => value && !allowed[key])) return undefined;
  return { ...allowed, asOf: result.asOf ?? filters.asOf ?? '' };
}

export function validReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validRosterFilters(filters: Filters): boolean {
  const { asOf, workDateFrom: from, workDateTo: to, employeeStatus } = filters;
  return Boolean(
    asOf &&
    validReportDate(asOf) &&
    (!from || validReportDate(from)) &&
    (!to || validReportDate(to)) &&
    (!from || !to || from <= to) &&
    (!employeeStatus || employeeStatus === '2' || employeeStatus === '3'),
  );
}

export function validStructureFilters(filters: Filters): boolean {
  return (
    validReportDate(filters.asOf ?? '') &&
    HR_STRUCTURE_REPORT_EMPLOY_TYPES.some((type) => type === filters.employType) &&
    ['true', 'false'].includes(filters.departmentIncludeChildren ?? '')
  );
}

export function movementMonthLimit({ asOf, year }: Filters): number {
  const asOfYear = asOf?.slice(0, 4);
  return Number(year || asOfYear) === Number(asOfYear) ? Number(asOf?.slice(5, 7)) || 12 : 12;
}

export function validMovementFilters({ asOf = '', year, month }: Filters): boolean {
  const lastYear = Number(asOf.slice(0, 4));
  return (
    validReportDate(asOf) &&
    lastYear >= 1900 &&
    (!year || (/^\d{1,4}$/.test(year) && Number(year) >= 1900 && Number(year) <= lastYear)) &&
    (!month ||
      (/^\d{1,2}$/.test(month) &&
        Number(month) >= 1 &&
        Number(month) <= movementMonthLimit({ asOf, year: year ?? '' })))
  );
}

export function movementResultFilters(filters: Filters, data: MovementReportData): Filters {
  return {
    ...filters,
    asOf: data.asOf,
    year: String(data.year),
    ...(data.month != null && { month: String(data.month) }),
  };
}

export interface ReportFailure {
  error: unknown;
  retryAt: number;
}
export function reportFailure(error: unknown): ReportFailure {
  const seconds = error instanceof ApiError && error.status === 429 ? error.retryAfter : undefined;
  return { error, retryAt: seconds ? Date.now() + seconds * 1000 : 0 };
}

/** 统计报表下载方式：formula = 含公式、隐藏行 / 列，data = 仅数据。 */
export type ExportMode = 'data' | 'formula';
export const pageSize = 20;
export function initialFilters(code: string, today: string): Filters {
  if (code === '1.07') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (['1.1.01', '1.1.02'].includes(code)) return {};
  const filters: Filters = { asOf: today };
  if (movement(code)) filters.year = today.slice(0, 4);
  if (code === 'institution') filters.month = String(Number(today.slice(5, 7)));
  if (structureReport(code)) {
    filters.employType = 'internal';
    filters.departmentIncludeChildren = 'true';
  }
  return filters;
}
/** 查询/导出共用已执行的筛选；不向统计接口发并不存在的分页参数。 */
export function reportUrl(
  report: PersonnelReport,
  filters: Filters,
  page?: number,
  exporting = false,
  mode?: ExportMode,
) {
  // 部门名称只供界面回显。B54 只有各机构接收月份，只有年度查询接收下钻节点（设计 §4.7）。
  const { code } = report;
  let keys = Object.keys(filters);
  if (structureReport(code)) keys = ['asOf', 'employType', 'departmentId', 'departmentIncludeChildren'];
  if (movement(code)) {
    keys = ['asOf', 'year', 'departmentId'];
    if (code === 'institution') keys.push('month');
    if (code === 'flow' && !exporting) keys.push('parentId');
  }
  const entries = keys.map((key): [string, string] => [key, filters[key] ?? '']);
  const params = new URLSearchParams(entries.filter(([, value]) => value !== ''));
  if (page !== undefined && !statistical(report.code)) {
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
  }
  if (exporting && mode) params.set('mode', mode);
  return `${report.endpoint}${exporting ? '/export' : ''}?${params}`;
}
export function errorText(error: unknown, exporting = false): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return exporting ? m.exportDenied : m.forbidden;
    if (error.status === 401) return m.expired;
    if (error.status === 404) return m.missing;
    if (error.status === 429) return m.rateLimit;
    if (error.status === 400) return m.invalid;
    if (error.status === 413 && error.code === 'PAYLOAD_TOO_LARGE') return m.tooLarge;
    if (exporting && error.status === 422 && error.code === 'VALIDATION_FAILED' && error.reason === 'EXPORT_ROW_LIMIT')
      return m.exportLimit;
  }
  return exporting ? m.exportFailed : m.failed;
}
export function cellText(key: string, value: unknown) {
  if (key === 'code') return codeText((value as string | null) ?? null);
  if (value === null || value === undefined) return '—';
  if (key === 'growthRate' && typeof value === 'number')
    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  const isRatio = key === 'rate' || (key.startsWith('employType:') && key.endsWith(':ratio'));
  if (isRatio && typeof value === 'number')
    return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 }).format(value);
  if (key === 'termType') return TERM_TYPE_LABELS[String(value)] ?? String(value);
  return reportCellLabel(key, value) ?? rosterCellText(key, value);
}
/** 仅适配服务器表格形状，不计算汇总、范围或统计口径。 */
export interface DisplayTable {
  key: string;
  name?: string;
  columns: Column[];
  rows: Row[];
  total: number;
  summary?: Row;
}
export function tablesOf(code: string, data: ReportData, drilled = false): DisplayTable[] {
  if ('items' in data) return [{ key: code, columns: data.columns, rows: data.items, total: data.total }];
  const tables = 'tables' in data ? data.tables : [data];
  return tables.map((table, index) => ({
    key: table.key ?? String(index),
    name: table.name,
    columns: [
      {
        key: '_label',
        label:
          ({ monthly: m.groupMonth, institution: m.institution } as Record<string, string>)[code] ??
          (code === 'flow' && drilled ? m.drillOrganization : m.organization),
      },
      ...table.columns,
    ],
    rows: table.rows.map((row) => ({
      ...row.cells,
      _label: row.label ?? row.organizationName,
      ...(code === 'flow' && { _organizationId: row.key }),
    })),
    total: table.rows.length,
    summary: { ...table.summary.cells, _label: m.summary },
  }));
}
