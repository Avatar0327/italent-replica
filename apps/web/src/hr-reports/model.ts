import { codeText } from '../foundation/code-text.js';
import {
  PERSONNEL_REPORTS,
  reportCellLabel,
  rosterCellText,
  TERM_TYPE_LABELS,
  type PersonnelReport,
} from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { m } from './messages.js';
export const base = '/api/tenant/hr-analysis/reports';
export const reportOf = (code: string) => PERSONNEL_REPORTS.find((r) => r.code === code);
export const statistical = (code: string) => ['monthly', 'institution', 'quality'].includes(code);
export const movement = (code: string) => ['monthly', 'institution'].includes(code);
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
  columns: Column[];
  rows: { key?: string; label?: string; organizationId?: string; organizationName?: string; cells: Row }[];
  summary: { cells: Row };
  key?: string;
  name?: string;
}
export type ReportData =
  RosterPage | (Statistics & { hasDataPermission: boolean }) | { tables: Statistics[]; hasDataPermission: boolean };
export interface CatalogItem extends Pick<PersonnelReport, 'code' | 'name' | 'group' | 'endpoint'> {
  available: boolean;
  reason?: string;
}
export type Filters = Record<string, string>;
/** 统计报表下载方式：formula = 含公式、隐藏行 / 列，data = 仅数据。 */
export type ExportMode = 'data' | 'formula';
export const pageSize = 20;
export function initialFilters(code: string, today: string): Filters {
  if (code === '1.07') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (['1.1.01', '1.1.02'].includes(code)) return {};
  const filters: Filters = { asOf: today };
  if (movement(code)) filters.year = today.slice(0, 4);
  if (code === 'institution') filters.month = String(Number(today.slice(5, 7)));
  if (code === 'quality') filters.employType = 'internal';
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
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
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
  }
  return exporting ? m.exportFailed : m.failed;
}
export function cellText(key: string, value: unknown) {
  if (key === 'code') return codeText((value as string | null) ?? null);
  if (value === null || value === undefined) return '—';
  if (key === 'rate' && typeof value === 'number')
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
export function tablesOf(code: string, data: ReportData): DisplayTable[] {
  if ('items' in data) return [{ key: code, columns: data.columns, rows: data.items, total: data.total }];
  const tables = 'tables' in data ? data.tables : [data];
  return tables.map((table, index) => ({
    key: table.key ?? String(index),
    name: table.name,
    columns: [
      {
        key: '_label',
        label:
          ({ monthly: m.groupMonth, institution: m.institution } as Record<string, string>)[code] ?? m.organization,
      },
      ...table.columns,
    ],
    rows: table.rows.map((row) => ({ ...row.cells, _label: row.label ?? row.organizationName })),
    total: table.rows.length,
    summary: { ...table.summary.cells, _label: m.summary },
  }));
}
