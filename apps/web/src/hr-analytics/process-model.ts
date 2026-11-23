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
import { m } from './messages.js';
import { candidateUuid, validAsOf, type ChartPoint, type TrendSeries } from './model.js';

const base = '/api/tenant/analytics/hr-process-dashboard';
const p = m.processBoard;
const modules = ['inFlight', 'timeliness', 'quality', 'usage'] as const;
const COUNT_CODES = new Set<HrProcessComponentCode>([
  'inFlightAbnormal',
  'inFlightByApprover',
  'lateSubmitByCategory',
  'lateSubmitByInitiator',
  'lateApprovalByCategory',
]);
const CATEGORY_CODES = new Set<HrProcessComponentCode>([
  'durationByCategory',
  'lateSubmitByCategory',
  'lateApprovalByCategory',
  'submitLagByCategory',
  'approveLagByCategory',
]);
const LAG_CODES = new Set<HrProcessComponentCode>([
  'submitLag',
  'submitLagByCategory',
  'approveLag',
  'approveLagByCategory',
]);
const LAG_CARDS = new Set<HrProcessComponentCode>(['submitLag', 'approveLag']);

export interface ProcessGroup {
  key: string;
  label: string | null;
  series: string | null;
  count: number;
  hits: number | null;
  rate: number | null;
  average: number | null;
}
export type ProcessComponent = HrProcessComponent & {
  total: number;
  hits: number | null;
  rate: number | null;
  average: number | null;
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

/** 7.2.11 与 ④ 应用：rate / hits / total 全取服务端回执，前端不重算占比。 */
export const isProcessRatio = ({ code, module }: HrProcessComponent) =>
  module === 'usage' || code === 'nonCompliantByWeek';

/** 7.2.15 回执是任务级聚合，规格要实例级排名：首版只显示占位，不出图、不读明细（U6，DEC-962，F-543）。 */
export const processUnavailable = (code: HrProcessComponentCode) => code === 'lateApprovalByApprover';

export const isProcessStat = (component: HrProcessComponent) =>
  ['inFlightCount', 'inFlightAbnormal', 'inFlightWaiting'].includes(component.code) ||
  LAG_CARDS.has(component.code) ||
  isProcessRatio(component);

const ratioLabels = (code: HrProcessComponentCode) => (code === 'nonCompliantByWeek' ? p.nonCompliant : p.approval);

/** 钻取命中项（分子）时在抽屉语境里标明。 */
export const processDrillLabel = (component: HrProcessComponent, drill: ProcessDrill) =>
  isProcessRatio(component) && drill.hit === true ? ratioLabels(component.code).hits : undefined;

/** 维度列名：应用分区按回执分组主体（docs/08_设计/R2-T10 §B51 7.1.20～24）。 */
export function processDimension({ code, module }: HrProcessComponent) {
  if (code === 'lateSubmitByInitiator') return p.initiatorId;
  if (code === 'offerApprovalRate') return p.offerDepartment;
  if (code === 'contractApprovalRate') return p.signingCompany;
  return module === 'usage' ? p.secondLevelOrg : undefined;
}

function categoryName(value: string) {
  return APPROVAL_CATEGORY_NAMES[value as ApprovalCategory] ?? value;
}

function abnormalName(value: string) {
  return p.abnormalTypes[value as keyof typeof p.abnormalTypes] ?? value;
}

function groupName(code: HrProcessComponentCode, key: string) {
  if (code === 'inFlightAbnormal') return abnormalName(key);
  if (CATEGORY_CODES.has(code)) return categoryName(key);
  return key;
}

const daysText = (value: number | null) => (value === null ? cellText('value', value) : p.days(value));

export interface ProcessMetric {
  label: string;
  value: number | null;
  text?: string;
  drill?: ProcessDrill;
}

export function processMetrics(component: ProcessComponent): ProcessMetric[] {
  const { code, total, hits, rate, average } = component;
  if (isProcessRatio(component)) {
    const labels = ratioLabels(code);
    return [
      { label: labels.rate, value: rate, text: cellText('rate', rate) },
      { label: labels.hits, value: hits, drill: { hit: true } },
      { label: labels.total, value: total, drill: {} },
    ];
  }
  if (LAG_CARDS.has(code)) return [{ label: p.averageLag, value: average, text: daysText(average), drill: {} }];
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

export interface ProcessPoint extends ChartPoint {
  category: string;
  categoryLabel: string;
  series: string | null;
  drill: ProcessDrill;
  /** 同一分组派生的多个图形点共用的分组选项键（抽屉分组选择用）。 */
  option?: string;
}
interface ProcessSeries extends TrendSeries {
  points: ProcessPoint[];
}

function pointValue(component: ProcessComponent, { count, rate, average }: ProcessGroup) {
  if (isProcessRatio(component)) return { value: rate, text: cellText('rate', rate) };
  if (COUNT_CODES.has(component.code)) return { value: count, text: cellText('count', count) };
  return { value: average, text: daysText(average) };
}

// 按码位比较，与服务端排序键一致（不随浏览器区域设置变化）
const byKey = (a: string, b: string) => Number(a > b) - Number(a < b);

export function processPoints(component: ProcessComponent): ProcessPoint[] {
  const { code, groups } = component;
  const points = groups.map((item) => {
    const { key, label, series } = item;
    const categoryLabel = label || groupName(code, key);
    return {
      key: JSON.stringify([key, series]),
      category: key,
      categoryLabel,
      series,
      label: series === null ? categoryLabel : `${categoryLabel} · ${categoryName(series)}`,
      ...pointValue(component, item),
      drill: { group: key, series: series ?? undefined },
    };
  });
  // 7.2.13 排名：数量降序，同值按键（docs/08_设计/R2-T10 §B51）
  if (code === 'lateSubmitByInitiator') {
    points.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || byKey(a.category, b.category));
  }
  return points;
}

/** 比率组件的柱线组合：占比为柱，分子、分母为线；分子与占比钻取带 hit=true，分母不带。 */
function ratioSeries(component: ProcessComponent, points: readonly ProcessPoint[]): ProcessSeries[] {
  const labels = ratioLabels(component.code);
  const byGroup = new Map(component.groups.map((item) => [item.key, item]));
  const derived = (field: 'rate' | 'hits' | 'count', label: string, hit?: true): ProcessSeries => ({
    key: field,
    label,
    points: points.map((point) => {
      const value = byGroup.get(point.category)?.[field] ?? null;
      return {
        ...point,
        key: JSON.stringify([point.category, field]),
        option: point.key,
        value,
        text: cellText(field === 'rate' ? 'rate' : 'count', value),
        hint: label,
        drill: hit ? { ...point.drill, hit } : point.drill,
      };
    }),
  });
  return [derived('rate', labels.rate, true), derived('hits', labels.hits, true), derived('count', labels.total)];
}

export function processTrend(component: ProcessComponent, points: readonly ProcessPoint[]) {
  const categories = [
    ...new Map(
      points.map(({ category, categoryLabel }) => [category, { key: category, label: categoryLabel }]),
    ).values(),
  ];
  let series: ProcessSeries[];
  if (isProcessRatio(component)) {
    series = ratioSeries(component, points);
  } else if (component.code === 'inFlightByApprover') {
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

function hitLabel(data: ProcessDetail) {
  if (isProcessRatio(data)) return ratioLabels(data.code).hit;
  if (data.code === 'inFlightCount') return p.inFlightCount;
  return data.code === 'inFlightWaiting' ? p.overSevenDays : undefined;
}

const idLabels: Partial<Record<HrProcessComponent['subject'], string>> = { task: p.taskId, business: p.businessId };

export function processDetailTable(data: ProcessDetail): DisplayTable {
  const lag = LAG_CODES.has(data.code);
  const averages = data.module === 'timeliness' || lag;
  const hit = hitLabel(data);
  const later = data.module === 'quality' || data.module === 'usage';
  const group =
    data.code === 'inFlightAbnormal' ||
    data.code === 'inFlightByApprover' ||
    data.module === 'timeliness' ||
    (later && !LAG_CARDS.has(data.code));
  const id = idLabels[data.subject];
  const columns = {
    ...(id ? { id } : {}),
    instanceId: p.listColumns.instanceId,
    ...(group ? { group: processDimension(data) ?? m.group } : {}),
    ...(data.code === 'inFlightByApprover' ? { series: p.category } : {}),
    ...(averages ? { value: lag ? p.lagDays : p.sampleDays } : {}),
    ...(hit ? { hit } : {}),
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
