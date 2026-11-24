import { HR_DASHBOARD_INDICATORS, type HrDashboardIndicator, type HrDashboardCode } from '@italent/domain';
import { ApiError, pageQuery } from '../foundation/client.js';
import { m as report } from '../hr-reports/messages.js';
import { pageSize, type DisplayTable } from '../hr-reports/model.js';
import { m } from './messages.js';

export const organizationCandidatesUrl = (object: string, asOf: string) =>
  `/api/tenant/analytics/organization-candidates?${new URLSearchParams({ object, asOf })}`;

export interface MemberDetail {
  asOf: string;
  hasDataPermission: boolean;
  group: string | null;
  total: number;
  page: number;
  pageSize: number;
  items: { id: string; employeeId: string; organizationId: string | null }[];
}

export function memberDetailTable(data: MemberDetail & { code: string }): DisplayTable {
  return {
    key: data.code,
    columns: [
      { key: 'employeeId', label: m.id.employee },
      { key: 'organizationId', label: m.id.org },
    ],
    rows: data.items,
    total: data.total,
  };
}

export type GroupChartKind = 'column' | 'bar' | 'pie';
export interface ChartPoint {
  key: string;
  label: string;
  value: number | null;
  text: string;
  hint?: string;
}

export interface TrendAxisItem {
  key: string;
  label: string;
}
export interface TrendPoint extends ChartPoint {
  category: string;
}
export interface TrendSeries {
  key: string;
  label?: string;
  points: TrendPoint[];
}
export interface NestedChartPoint extends ChartPoint {
  parent: string | null;
}

const base = '/api/tenant/analytics/hr-dashboard';
export const asOfBounds = { min: '0001-01-02', max: '9999-12-01' };

export function validAsOf(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < asOfBounds.min || value > asOfBounds.max) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function overviewUrl(asOf: string) {
  return `${base}?${new URLSearchParams({ asOf })}`;
}

export function detailUrl(code: HrDashboardCode, asOf: string, page: number) {
  const params = new URLSearchParams({ asOf });
  pageQuery({ page, pageSize }).forEach((value, key) => params.set(key, value));
  return `${base}/indicators/${encodeURIComponent(code)}?${params}`;
}

export type DashboardMetric = HrDashboardIndicator & { value: number | null };
export interface DashboardOverview {
  asOf: string;
  hasDataPermission: boolean;
  indicators: DashboardMetric[];
}
export type DashboardDetail = HrDashboardIndicator & {
  asOf: string;
  hasDataPermission: boolean;
  total: number;
  page: number;
  pageSize: number;
  items: { id: string; employeeId: string | null }[];
};

// 只规定布局顺序，名称、统计日期和数值均来自当前回执。
const endOfGroups = [4, 8, 14, 19, 23];
export function indicatorGroups(indicators: readonly DashboardMetric[]) {
  const byCode = new Map(indicators.map((item) => [item.code, item]));
  return endOfGroups.map((end, index) => ({
    title: m.groups[index]!,
    items: HR_DASHBOARD_INDICATORS.slice(endOfGroups[index - 1] ?? 0, end).flatMap(({ code }) => {
      const item = byCode.get(code);
      return item ? [item] : [];
    }),
  }));
}

const indicatorIdLabels: Partial<Record<HrDashboardCode, string>> = {
  pendingEntries: m.id.record,
  contractApproving: m.id.business,
};

export function detailTable(data: DashboardDetail): DisplayTable {
  const label = indicatorIdLabels[data.code] ?? m.id[data.subject];
  return {
    key: data.code,
    columns: [{ key: 'id', label }, ...(label === m.id.employee ? [] : [{ key: 'employeeId', label: m.id.employee }])],
    rows: data.items.map(({ id, employeeId }) => ({ id, employeeId })),
    total: data.total,
  };
}

export const readStatus = (error: unknown) => (error instanceof ApiError ? error.status : undefined);
// 组织候选 ID 校验放在纯模型里，供不含 JSX 的流程模型与验收测试共用
export const candidateUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canRetryRead(error: unknown) {
  const status = readStatus(error);
  return status === 429 || status === 0 || (status !== undefined && status >= 500);
}

export function boardErrorText(error: unknown, detail: boolean, missing: string = m.indicatorMissing) {
  if (error instanceof ApiError && error.status === 413 && error.code === 'PAYLOAD_TOO_LARGE') return m.limit;
  switch (readStatus(error)) {
    case 403:
      return detail ? m.detailDenied : m.boardDenied;
    case 404:
      return detail ? missing : m.boardMissing;
    case 400:
      return report.invalid;
    case 429:
      return report.rateLimit;
    default:
      return detail ? m.detailFailed : m.failed;
  }
}
