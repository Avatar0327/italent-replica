import { HR_STRUCTURE_COMPONENTS, type BoardComponentKind, type HrStructureCode } from '@italent/domain';
import { pageQuery } from '../foundation/client.js';
import { cellText, pageSize, type DisplayTable, type Filters } from '../hr-reports/model.js';
import type { ChartPoint, GroupChartKind } from './model.js';
import { m } from './messages.js';

const base = '/api/tenant/analytics/hr-structure';

export const organizationFilters = {
  institutionId: 'institutionIncludeChildren',
  departmentId: 'departmentIncludeChildren',
} as const;
export const dictionaryFilters = ['sequenceId', 'employmentForm', 'employmentType'] as const;
export const includeChildrenDefaults = { institutionIncludeChildren: 'true', departmentIncludeChildren: 'true' };

export function structureOrgUrl(asOf: string) {
  return `/api/tenant/analytics/organization-candidates?${new URLSearchParams({ object: 'HrStructure', asOf })}`;
}

function queryOf(filters: Filters) {
  const params = new URLSearchParams({ asOf: filters.asOf! });
  for (const key of Object.keys(organizationFilters) as (keyof typeof organizationFilters)[]) {
    const id = filters[key];
    if (!id) continue;
    const include = organizationFilters[key];
    params.set(key, id);
    params.set(include, filters[include] === 'false' ? 'false' : 'true');
  }
  for (const key of dictionaryFilters) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params;
}

export const structureOverviewUrl = (filters: Filters) => `${base}?${queryOf(filters)}`;

export function structureDetailUrl(code: HrStructureCode, filters: Filters, page: number, group?: string) {
  const params = queryOf(filters);
  if (group !== undefined) params.set('group', group);
  pageQuery({ page, pageSize }).forEach((value, key) => params.set(key, value));
  return `${base}/components/${encodeURIComponent(code)}?${params}`;
}

interface StructureGroup {
  key: string;
  label: string;
  count: number;
  total?: number;
  ratio?: number | null;
}
interface StructureComponent {
  code: HrStructureCode;
  name: string;
  kind: BoardComponentKind;
  value: number | null;
  count?: number;
  groups: StructureGroup[] | null;
}
export interface StructureOverview {
  asOf: string;
  hasDataPermission: boolean;
  components: StructureComponent[];
}
export interface StructureDetail extends Pick<StructureComponent, 'code' | 'name' | 'kind'> {
  asOf: string;
  hasDataPermission: boolean;
  group: string | null;
  total: number;
  page: number;
  pageSize: number;
  items: { id: string; employeeId: string; organizationId: string | null }[];
}

const charts: Partial<Record<HrStructureCode, GroupChartKind>> = {
  '6.04': 'column',
  '6.05': 'bar',
  '6.06': 'column',
  '6.07': 'pie',
  '6.08': 'column',
  '6.11': 'bar',
  '6.12': 'pie',
  '6.13': 'column',
  '6.14': 'pie',
};
const units: Partial<Record<HrStructureCode, string>> = { '6.02': m.age, '6.03': m.years };

export function structureCards(data: StructureOverview) {
  const byCode = new Map(data.components.map((component) => [component.code, component]));
  return HR_STRUCTURE_COMPONENTS.flatMap(({ code }) => {
    const component = byCode.get(code);
    if (!component) return [];
    const ratio = component.kind === 'ratio';
    const points: ChartPoint[] = (component.groups ?? []).map(({ key, label, count, total, ratio: rate }) => ({
      key,
      label,
      value: ratio ? (rate ?? null) : count,
      text: ratio ? `${cellText('rate', rate)} · ${count} / ${cellText('value', total)}` : cellText('value', count),
    }));
    const body: GroupChartKind | 'stat' | 'map' = component.kind === 'unavailable' ? 'map' : (charts[code] ?? 'stat');
    const unit = units[code];
    const value = cellText('value', component.value);
    return [
      {
        code,
        name: component.name,
        body,
        text: unit && component.value !== null ? `${value} ${unit}` : value,
        wholeCount: component.kind === 'average' ? (component.count ?? null) : component.value,
        ratio,
        points,
      },
    ];
  });
}
export type StructureCard = ReturnType<typeof structureCards>[number];

export function structureDetailTable(data: StructureDetail): DisplayTable {
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
