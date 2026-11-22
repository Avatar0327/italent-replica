import {
  addDays,
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_NAMES,
  HR_PROCESS_COMPONENTS,
  HR_PROCESS_DEFAULT_DAYS,
  type ApprovalCategory,
  type HrProcessComponent,
  type HrProcessComponentCode,
} from '@italent/domain';
import { pageQuery } from '../foundation/client.js';
import { cellText, pageSize, type DisplayTable, type Filters, type Row } from '../hr-reports/model.js';
import { candidateUuid } from './BoardCandidates.js';
import { m } from './messages.js';
import { validAsOf, type ChartPoint, type TrendSeries } from './model.js';

const base = '/api/tenant/analytics/hr-process-dashboard';
const p = m.processBoard;
const modules = ['inFlight', 'timeliness'] as const;

export interface ProcessGroup {
  key: string;
  label: string | null;
  series: string | null;
  count: number;
  average: number | null;
}
export type ProcessComponent = HrProcessComponent & {
  total: number;
  hits: number | null;
  groups: ProcessGroup[];
};
interface ProcessWindow {
  asOf: string;
  from: string;
  to: string;
  hasDataPermission: boolean;
}
export interface ProcessOverview extends ProcessWindow {
  components: ProcessComponent[];
}
export type ProcessDetail = HrProcessComponent &
  ProcessWindow & {
    total: number;
    items: Row[];
    page: number;
    pageSize: number;
  };
export interface ProcessDrill {
  group?: string;
  series?: string;
  hit?: boolean;
}

export const processDefaults = (asOf: string): Filters => ({
  asOf,
  from: addDays(asOf, 1 - HR_PROCESS_DEFAULT_DAYS),
  to: asOf,
});

export function validProcessFilters({ from, to, category, departmentId }: Filters) {
  return Boolean(
    from &&
    to &&
    validAsOf(from) &&
    validAsOf(to) &&
    from <= to &&
    (!category || APPROVAL_CATEGORIES.some((item) => item === category)) &&
    (!departmentId || candidateUuid.test(departmentId)),
  );
}

function processParams({ asOf, from, to, category, departmentId }: Filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ asOf, from, to, category, departmentId })) {
    if (value) params.set(key, value);
  }
  return params;
}

export const processOverviewUrl = (filters: Filters) => `${base}?${processParams(filters)}`;

export function processResultFilters(filters: Filters, { asOf, from, to }: ProcessWindow): Filters {
  return { ...filters, asOf, from, to };
}

export function processDetailUrl(code: HrProcessComponentCode, filters: Filters, page: number, drill: ProcessDrill) {
  const params = processParams(filters);
  for (const [key, value] of Object.entries(drill)) {
    if (value !== undefined) params.set(key, String(value));
  }
  pageQuery({ page, pageSize }).forEach((value, key) => params.set(key, value));
  return `${base}/components/${encodeURIComponent(code)}?${params}`;
}

export function processSections(components: readonly ProcessComponent[]) {
  const byCode = new Map(components.map((item) => [item.code, item]));
  return modules.map((module) => ({
    module,
    items: HR_PROCESS_COMPONENTS.filter((item) => item.module === module).flatMap(({ code }) => {
      const item = byCode.get(code);
      return item ? [item] : [];
    }),
  }));
}

function categoryName(value: string) {
  return APPROVAL_CATEGORY_NAMES[value as ApprovalCategory] ?? value;
}

function abnormalName(value: string) {
  return p.abnormalTypes[value as keyof typeof p.abnormalTypes] ?? value;
}

function groupName(code: HrProcessComponentCode, key: string) {
  if (code === 'inFlightAbnormal') return abnormalName(key);
  if (code === 'durationByCategory') return categoryName(key);
  return key;
}

export function processMetrics({ code, total, hits }: ProcessComponent) {
  if (code === 'inFlightCount') {
    return [
      { label: p.started, value: total, drill: {} },
      { label: p.inFlightCount, value: hits, drill: { hit: true } },
      { label: p.notInFlight, value: hits === null ? null : total - hits, drill: { hit: false } },
    ];
  }
  if (code === 'inFlightWaiting') {
    return [
      { label: p.overThreeDays, value: total, drill: {} },
      { label: p.overSevenDays, value: hits, drill: { hit: true } },
    ];
  }
  return [{ label: p.abnormalTotal, value: total, drill: {} }];
}

const daysText = (value: number | null) => (value === null ? cellText('value', value) : p.days(value));

interface ProcessPoint extends ChartPoint {
  category: string;
  categoryLabel: string;
  series: string | null;
  drill: ProcessDrill;
}

export function processPoints({ code, groups }: ProcessComponent): ProcessPoint[] {
  return groups.map(({ key, label, series, count, average }) => {
    const categoryLabel = label || groupName(code, key);
    const countOnly = code === 'inFlightAbnormal' || code === 'inFlightByApprover';
    return {
      key: JSON.stringify([key, series]),
      category: key,
      categoryLabel,
      series,
      label: series === null ? categoryLabel : `${categoryLabel} · ${categoryName(series)}`,
      value: countOnly ? count : average,
      text: countOnly ? cellText('count', count) : daysText(average),
      drill: { group: key, series: series ?? undefined },
    };
  });
}

export function processTrend(component: ProcessComponent, points: readonly ProcessPoint[]) {
  const categories = [
    ...new Map(
      points.map(({ category, categoryLabel }) => [category, { key: category, label: categoryLabel }]),
    ).values(),
  ];
  let series: TrendSeries[];
  if (component.code === 'inFlightByApprover') {
    series = APPROVAL_CATEGORIES.flatMap((key) => {
      const matches = points.filter((point) => point.series === key);
      return matches.length ? [{ key, label: categoryName(key), points: matches }] : [];
    });
  } else {
    series = [{ key: 'average', label: p.averageDays, points: [...points] }];
    if (component.code === 'taskDurationByApprover') {
      const countByGroup = new Map(component.groups.map(({ key, count }) => [key, count]));
      series.push({
        key: 'count',
        label: p.taskCount,
        points: points.map((point) => {
          const count = countByGroup.get(point.category)!;
          return { ...point, value: count, text: cellText('count', count), hint: p.taskCount };
        }),
      });
    }
  }
  return { categories, series };
}

const columnsOf = (columns: Readonly<Record<string, string>>) =>
  Object.entries(columns).map(([key, label]) => ({ key, label }));

export function inFlightTable(detail: ProcessDetail | undefined, timezone: string): DisplayTable {
  const timestamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  });
  const formatTime = (value: unknown) => (typeof value === 'string' ? timestamp.format(new Date(value)) : null);
  return {
    key: 'inFlightList',
    columns: columnsOf(p.listColumns),
    total: detail?.total ?? 0,
    rows: (detail?.items ?? []).map((row) => ({
      ...row,
      category: typeof row.category === 'string' ? categoryName(row.category) : null,
      approverStatus: p.approverStatus[row.approverStatus as keyof typeof p.approverStatus],
      waitBucket: p.waitBucket[row.waitBucket as keyof typeof p.waitBucket],
      abnormalTypes:
        Array.isArray(row.abnormalTypes) && row.abnormalTypes.length
          ? row.abnormalTypes.map(abnormalName).join('、')
          : null,
      startedAt: formatTime(row.startedAt),
      arrivedAt: formatTime(row.arrivedAt),
    })),
  };
}

export function processDetailTable(data: ProcessDetail): DisplayTable {
  const averages = data.module === 'timeliness';
  const hits = data.code === 'inFlightCount' || data.code === 'inFlightWaiting';
  const hitLabel = data.code === 'inFlightCount' ? p.inFlightCount : p.overSevenDays;
  const group = data.code === 'inFlightAbnormal' || data.code === 'inFlightByApprover' || averages;
  const columns = {
    ...(data.subject === 'task' ? { id: p.taskId } : {}),
    instanceId: p.listColumns.instanceId,
    ...(group ? { group: m.group } : {}),
    ...(data.code === 'inFlightByApprover' ? { series: p.category } : {}),
    ...(averages ? { value: p.sampleDays } : {}),
    ...(hits ? { hit: hitLabel } : {}),
  };
  return {
    key: data.code,
    columns: columnsOf(columns),
    total: data.total,
    rows: data.items.map((row) => ({
      ...row,
      group: typeof row.group === 'string' ? groupName(data.code, row.group) : null,
      series: typeof row.series === 'string' ? categoryName(row.series) : null,
      hit: typeof row.hit === 'boolean' ? p.hit[String(row.hit) as keyof typeof p.hit] : null,
    })),
  };
}
