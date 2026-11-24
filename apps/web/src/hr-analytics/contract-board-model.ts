import { CONTRACT_BOARD_COMPONENTS, TERM_TYPE_LABELS, type ContractBoardCode } from '@italent/domain';
import { pageQuery } from '../foundation/client.js';
import { cellText, pageSize, type DisplayTable, type Filters } from '../hr-reports/model.js';
import { m } from './messages.js';
import { validAsOf, type ChartPoint } from './model.js';

const base = '/api/tenant/analytics/contract-board';
const filterKeys = ['changeFrom', 'changeTo', 'companyId', 'typeId', 'termType'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const contractTermOptions = (['fixed', 'indefinite', 'task'] as const).map((value) => ({
  value,
  label: TERM_TYPE_LABELS[value]!,
}));

export function initialContractFilters(asOf: string) {
  const year = asOf.slice(0, 4);
  return { asOf, changeFrom: `${year}-01-01`, changeTo: `${year}-12-31` };
}

export function appliedContractFilters(filters: Filters, asOf: string) {
  const defaults = initialContractFilters(asOf);
  return {
    ...filters,
    asOf,
    changeFrom: filters.changeFrom || defaults.changeFrom,
    changeTo: filters.changeTo || defaults.changeTo,
  };
}

export function validContractFilters(filters: Filters, asOf: string) {
  const { changeFrom, changeTo } = appliedContractFilters(filters, asOf);
  const defaults = initialContractFilters(asOf);
  return (
    validAsOf(asOf) &&
    (changeFrom === defaults.changeFrom || validAsOf(changeFrom)) &&
    (changeTo === defaults.changeTo || validAsOf(changeTo)) &&
    changeFrom <= changeTo &&
    (!filters.companyId || uuid.test(filters.companyId)) &&
    (!filters.typeId || uuid.test(filters.typeId)) &&
    (!filters.termType || contractTermOptions.some(({ value }) => value === filters.termType))
  );
}

function queryOf(filters: Filters) {
  const params = new URLSearchParams({ asOf: filters.asOf! });
  const defaults = initialContractFilters(filters.asOf!);
  for (const key of filterKeys) {
    const value = filters[key];
    if (!value) continue;
    // 端点的显式日期共用 asOf 边界；极端年份的默认首尾日由服务端补齐。
    if ((key === 'changeFrom' || key === 'changeTo') && value === defaults[key] && !validAsOf(value)) continue;
    params.set(key, value);
  }
  return params;
}

export const contractOverviewUrl = (filters: Filters) => `${base}?${queryOf(filters)}`;

export function contractDetailUrl(code: ContractBoardCode, filters: Filters, page: number, group?: string) {
  const params = queryOf(filters);
  if (group !== undefined) params.set('group', group);
  pageQuery({ page, pageSize }).forEach((value, key) => params.set(key, value));
  return `${base}/components/${encodeURIComponent(code)}?${params}`;
}

type ContractComponent = (typeof CONTRACT_BOARD_COMPONENTS)[number] & {
  value: number | null;
  groups: { key: string; label: string; count: number; ratio?: number | null }[] | null;
};
export interface ContractOverview {
  asOf: string;
  hasDataPermission: boolean;
  components: ContractComponent[];
}
export interface ContractDetail extends Pick<ContractComponent, 'code' | 'name' | 'kind'> {
  asOf: string;
  hasDataPermission: boolean;
  group: string | null;
  total: number;
  page: number;
  pageSize: number;
  items: { id: string; employeeId: string | null; organizationId: string | null }[];
}

export function contractCards(data: ContractOverview) {
  const byCode = new Map(data.components.map((item) => [item.code, item]));
  return CONTRACT_BOARD_COMPONENTS.flatMap(({ code }) => {
    const component = byCode.get(code);
    if (!component) return [];
    const points: ChartPoint[] = (component.groups ?? []).map(({ key, label, count, ratio }) => ({
      key,
      label,
      value: count,
      text:
        code === 'signByCompany'
          ? `${m.contract.people(count)} · ${cellText('rate', ratio)}`
          : m.contract.people(count),
    }));
    return [
      {
        code,
        name: component.name,
        kind: component.kind,
        text: cellText('value', component.value),
        points,
      },
    ];
  });
}
export type ContractCard = ReturnType<typeof contractCards>[number];

export function contractDetailTable(data: ContractDetail): DisplayTable {
  return {
    key: data.code,
    columns: [
      { key: 'id', label: data.code.startsWith('change') ? m.id.business : m.id.contract },
      { key: 'employeeId', label: m.id.employee },
      { key: 'organizationId', label: m.id.org },
    ],
    rows: data.items.map(({ id, employeeId, organizationId }) => ({ id, employeeId, organizationId })),
    total: data.total,
  };
}
