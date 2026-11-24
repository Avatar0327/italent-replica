import { HR_MOVEMENT_COMPONENTS, type HrMovementCode, type MovementComponentKind } from '@italent/domain';
import { pageQuery } from '../foundation/client.js';
import { cellText, pageSize, type DisplayTable, type Filters } from '../hr-reports/model.js';
import type { ChartPoint, MemberDetail, NestedChartPoint, TrendAxisItem, TrendPoint, TrendSeries } from './model.js';
import { m } from './messages.js';

const base = '/api/tenant/analytics/hr-movement';
const requiredGroups = new Set<HrMovementCode>(['6.25', '6.26', '6.28', '3.1.36']);

export const movementNeedsGroup = (code: HrMovementCode) => requiredGroups.has(code);

function queryOf(filters: Filters) {
  const params = new URLSearchParams({ asOf: filters.asOf! });
  if (filters.departmentId) params.set('departmentId', filters.departmentId);
  return params;
}

export const movementOverviewUrl = (filters: Filters) => `${base}?${queryOf(filters)}`;

export function movementDetailUrl(code: HrMovementCode, filters: Filters, page: number, group?: string) {
  if (code === '6.32' || (movementNeedsGroup(code) && group === undefined)) return null;
  const params = queryOf(filters);
  if (group !== undefined) params.set('group', group);
  pageQuery({ page, pageSize }).forEach((value, key) => params.set(key, value));
  return `${base}/components/${encodeURIComponent(code)}?${params}`;
}

export interface MovementGroup {
  key: string;
  label: string;
  count: number;
  parent?: string | null;
  opening?: number;
  closing?: number;
  rate?: number;
  ratio?: number | null;
  orgId?: string;
  localCapacity?: number | null;
  inclusiveCapacity?: number | null;
  pendingIn?: number;
  pendingOut?: number;
  vacancy?: number | null;
  executionRate?: number | null;
}
interface Component {
  code: HrMovementCode;
  name: string;
  kind: MovementComponentKind;
  value: number | null;
  groups: MovementGroup[];
}

export interface MovementOverview {
  asOf: string;
  hasDataPermission: boolean;
  components: Component[];
}
export type MovementDetail = MemberDetail & Pick<Component, 'code' | 'name' | 'kind'>;

type CardHead = Pick<Component, 'code' | 'name'>;
type GroupOption = Pick<ChartPoint, 'key' | 'label'>;
type ChartCard = CardHead & { options: GroupOption[] } & (
    | { body: 'line' | 'area'; categories: TrendAxisItem[]; series: TrendSeries[]; percent?: boolean }
    | { body: 'pie' | 'column'; points: ChartPoint[]; total: number | null }
    | { body: 'nested-pie'; points: NestedChartPoint[]; total: number | null }
  );
type TableCard = CardHead & { body: 'table'; table: DisplayTable };
export type MovementCard = ChartCard | TableCard | (CardHead & { body: 'unavailable'; text: string });

const countText = (value: number | null | undefined) => cellText('count', value);

function countPoint({ key, label, count }: MovementGroup): ChartPoint {
  return { key, label, value: count, text: countText(count) };
}

function hireExitSeries(groups: readonly MovementGroup[]) {
  const categories = new Map<string, TrendAxisItem>();
  const series = Object.entries(m.movementSeries).map(([key, label]): TrendSeries => ({ key, label, points: [] }));
  const byKey = new Map(series.map((item) => [item.key, item]));
  for (const group of groups) {
    const [key, month] = group.key.split(':');
    const item = byKey.get(key!);
    if (!item || !month) continue;
    categories.set(month, { key: month, label: month });
    item.points.push({ ...countPoint(group), category: month });
  }
  return { categories: [...categories.values()], series };
}

function monthlySeries(groups: readonly MovementGroup[], percent: boolean) {
  return {
    categories: groups.map(({ key, label }) => ({ key, label })),
    series: [
      {
        key: 'months',
        points: groups.map((group): TrendPoint => ({
          ...countPoint(group),
          category: group.key,
          ...(percent && {
            value: group.rate ?? null,
            text: cellText('rate', group.rate),
            hint: m.movementRateDetail(countText(group.count), countText(group.opening), countText(group.closing)),
          }),
        })),
      },
    ],
  };
}

function nestedGroups(groups: readonly MovementGroup[]) {
  const labels = new Map(groups.filter(({ parent }) => parent === null).map(({ key, label }) => [key, label]));
  const points = groups
    .filter(({ parent }) => parent === null || (parent !== undefined && labels.has(parent)))
    .map((group): NestedChartPoint => ({ ...countPoint(group), parent: group.parent! }));
  const options = points.map(({ key, label, parent }) => ({
    key,
    label: parent === null ? label : `${labels.get(parent)} → ${label}`,
  }));
  return { points, options };
}

function establishmentTable(groups: readonly MovementGroup[]): DisplayTable {
  return {
    key: '3.1.36',
    columns: Object.entries(m.establishment).map(([key, label]) => ({ key, label })),
    rows: groups.map(
      ({
        key,
        label,
        orgId,
        localCapacity,
        inclusiveCapacity,
        count,
        pendingIn,
        pendingOut,
        vacancy,
        executionRate,
      }) => ({
        key,
        label,
        orgId,
        localCapacity,
        inclusiveCapacity,
        count,
        pendingIn,
        pendingOut,
        vacancy,
        executionRate,
      }),
    ),
    total: groups.length,
  };
}

function cardOf({ code, name, groups, value }: Component): MovementCard {
  const head = { code, name };
  // DEC-962 / U11：在服务端修正候选之前，整个组件只显示占位。
  if (code === '6.32') return { ...head, body: 'unavailable', text: m.statisticsUnavailable };
  if (code === '3.1.36') return { ...head, body: 'table', table: establishmentTable(groups) };
  const options = groups.map(({ key, label }) => ({ key, label }));
  if (code === '6.26') return { ...head, body: 'area', options, ...hireExitSeries(groups) };
  if (code === '6.25' || code === '6.28') {
    const percent = code === '6.28';
    return { ...head, body: 'line', options, percent, ...monthlySeries(groups, percent) };
  }
  if (code === '6.29' || code === '6.30') return { ...head, body: 'nested-pie', total: value, ...nestedGroups(groups) };
  return { ...head, body: code === '6.27' ? 'pie' : 'column', total: value, options, points: groups.map(countPoint) };
}

export function movementCards(data: MovementOverview): MovementCard[] {
  const components = new Map(data.components.map((component) => [component.code, component]));
  return HR_MOVEMENT_COMPONENTS.flatMap(({ code }) => {
    const component = components.get(code);
    return component ? [cardOf(component)] : [];
  });
}
