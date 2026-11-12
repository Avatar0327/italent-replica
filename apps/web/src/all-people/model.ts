import { codeText } from '../foundation/code-text.js';
import type { PageRequest } from '../foundation/client.js';
import { pageQuery } from '../foundation/client.js';

export const PERSON_OBJECT = 'TenantBase.EmployeeInformation';
export const RECORD_OBJECT = 'TenantBase.EmploymentRecord';
/** 原站每页 15 条（spec §2.3） */
export const PAGE_SIZE = 15;
/** 人员状态默认试用 + 正式（spec §2.3）；状态码同 EMPLOYEE_STATUS：2 试用、3 正式 */
export const DEFAULT_STATUSES: readonly number[] = [2, 3];

/** 后端 GET /employment/all-people 一行：键由 columns 决定，无字段权的键整体缺席；employeeId 恒有。 */
export type Row = { employeeId: string } & Record<string, string | number | null | undefined>;
export interface ColumnDef {
  key: string;
  label: string;
}

export interface Filters {
  employeeId?: string;
  name?: string;
  email?: string;
  employmentForm?: string;
  employType?: string;
  employeeStatus?: readonly number[];
  serviceType?: string;
}
export const defaultFilters: Filters = { employeeStatus: DEFAULT_STATUSES, serviceType: 'primary' };

/** 筛选键对应的字段权来源；字段不可见时不能带该筛选（后端会 403「花名册筛选字段不可查看」）。 */
export type FilterField = 'name' | 'email' | 'employeeStatus' | 'employmentForm' | 'employType' | 'serviceType';
export type Allowed = (field: FilterField) => boolean;

export function allowedFilters(filters: Filters, allowed: Allowed): Filters {
  const next: Filters = { ...filters };
  if (!allowed('name')) {
    delete next.name;
    delete next.employeeId;
  }
  for (const field of ['email', 'employeeStatus', 'employmentForm', 'employType', 'serviceType'] as const)
    if (!allowed(field)) delete next[field];
  return next;
}

export function allPeoplePath(filters: Filters, page: PageRequest): string {
  const query = pageQuery(page);
  const put = (key: string, value: string | undefined) => {
    if (value) query.set(key, value);
  };
  put('employeeId', filters.employeeId);
  put('name', filters.name?.trim());
  put('email', filters.email?.trim());
  put('employmentForm', filters.employmentForm);
  put('employType', filters.employType);
  if (filters.employeeStatus?.length) query.set('employeeStatus', [...filters.employeeStatus].join(','));
  put('serviceType', filters.serviceType);
  return `/api/tenant/employment/all-people?${query}`;
}

/** 列宽来自 spec §2.3；未列出的键（后端新增列）用 140。 */
const WIDTHS: Readonly<Record<string, number>> = {
  email: 200,
  directManagerName: 130,
  entryDate: 105,
  companyTenureYears: 172,
  age: 172,
};
export const columnWidth = (key: string) => WIDTHS[key] ?? 140;

export function cell(row: Row, key: string): string {
  const value = row[key];
  if (key === 'code') return codeText((value as string | null) ?? null);
  return value === null || value === undefined || value === '' ? '—' : String(value);
}
