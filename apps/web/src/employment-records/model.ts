import { codeText } from '../foundation/code-text.js';
import type { PageRequest } from '../foundation/client.js';
import { pageQuery } from '../foundation/client.js';
import { m } from './messages.js';

export const RECORD_OBJECT = 'TenantBase.EmploymentRecord';
export const EMPLOYEE_OBJECT = 'TenantBase.Employee';
export const PERSON_OBJECT = 'TenantBase.EmployeeInformation';
/** 原站每页 30 条（spec §2.4） */
export const PAGE_SIZE = 30;

/** 后端 GET /employment/records 一行；字段权不可见的键整体缺席。 */
export interface Row {
  id: string;
  employeeId: string;
  serviceType?: string;
  employeeCode?: string | null;
  employeeName?: string;
  kind?: string;
  effectiveDate?: string;
  isCurrent?: boolean;
  fields?: Record<string, unknown>;
  orgCode?: string | null;
  orgFullName?: string | null;
  departmentName?: string | null;
  orgLevels?: (string | null)[];
}

export interface Filters {
  name?: string;
  email?: string;
  /** working = 任职中；all = 不限；其余为员工状态码 */
  employeeStatus?: string;
  departmentId?: string;
  includeChildren?: boolean;
  /** yes / no / all */
  current?: string;
  approvalState?: string;
}
/** 原站默认值（spec §2.4）：任职中、生效、当前生效 = 是；接口自身不带默认，由页面显式传。 */
export const defaultFilters: Filters = { employeeStatus: 'working', approvalState: 'effective', current: 'yes' };

/** 筛选键对应的可见字段；对应字段不可见时不能带该筛选（后端会 403「筛选字段不可查看」）。 */
export type FilterField = 'name' | 'email' | 'employeeStatus' | 'departmentId' | 'isCurrent';
/** 'code' / 'serviceType' 只决定列，不是筛选键。 */
export type Allowed = (field: FilterField | 'code' | 'serviceType') => boolean;

export function allowedFilters(filters: Filters, allowed: Allowed): Filters {
  const next: Filters = { ...filters };
  if (!allowed('name')) delete next.name;
  if (!allowed('email')) delete next.email;
  if (!allowed('employeeStatus')) delete next.employeeStatus;
  if (!allowed('departmentId')) {
    delete next.departmentId;
    delete next.includeChildren;
  }
  // 是否当前生效不可见时连默认值一起丢掉：后端对不可见字段的 current 筛选一律 403（审查 R1 P2-1）
  if (!allowed('isCurrent')) delete next.current;
  return next;
}

export function recordsPath(filters: Filters, page: PageRequest): string {
  const query = pageQuery(page);
  const put = (key: string, value: string | undefined) => {
    if (value) query.set(key, value);
  };
  put('name', filters.name?.trim());
  put('email', filters.email?.trim());
  if (filters.employeeStatus && filters.employeeStatus !== 'all') put('employeeStatus', filters.employeeStatus);
  put('departmentId', filters.departmentId);
  if (filters.departmentId && filters.includeChildren === false) query.set('includeChildren', 'false');
  if (filters.current === 'yes') query.set('current', 'true');
  if (filters.current === 'no') query.set('current', 'false');
  if (filters.approvalState === 'effective') query.set('approvalState', 'effective');
  return `/api/tenant/employment/records?${query}`;
}

export interface ColumnSpec {
  key: 'name' | 'code' | 'serviceType' | 'org' | 'level1' | 'level2' | 'level3' | 'department';
  width: number;
  /** 行里承载该列的键；缺席（字段权）即不出列 */
  present(row: Row): boolean;
}
/** 列序与宽度来自 spec §2.4；齿轮列（列设置）原站内容未验证，不实现。 */
export const columns: readonly ColumnSpec[] = [
  { key: 'name', width: 140, present: (row) => 'employeeName' in row },
  { key: 'code', width: 140, present: (row) => 'employeeCode' in row },
  { key: 'serviceType', width: 140, present: (row) => 'serviceType' in row },
  { key: 'org', width: 140, present: (row) => 'orgFullName' in row },
  { key: 'level1', width: 140, present: (row) => 'orgLevels' in row },
  { key: 'level2', width: 140, present: (row) => 'orgLevels' in row },
  { key: 'level3', width: 140, present: (row) => 'orgLevels' in row },
  { key: 'department', width: 140, present: (row) => 'departmentName' in row },
];
/** 页内任一行带该字段就出列；一页都没有（含空页）时按字段权：姓名 / 工号 / 机构类取 allowed。 */
export function visibleColumns(rows: readonly Row[], allowed: Allowed, departmentAllowed: boolean): ColumnSpec[] {
  return columns.filter((column) => {
    // 任职类型随任职记录字段权：字段不可见时即使行里误带也不出列
    if (column.key === 'serviceType' && !allowed('serviceType')) return false;
    if (rows.length) return rows.some((row) => column.present(row));
    if (column.key === 'name') return allowed('name');
    if (column.key === 'code') return allowed('code');
    if (column.key === 'serviceType') return allowed('serviceType');
    return departmentAllowed;
  });
}

export function cell(row: Row, key: ColumnSpec['key']): string {
  const text = (value: string | null | undefined) => value || '—';
  switch (key) {
    case 'name':
      return text(row.employeeName);
    case 'code':
      return codeText(row.employeeCode ?? null);
    case 'serviceType':
      return row.serviceType === 'primary' ? m.primary : text(row.serviceType);
    case 'org':
      return text(row.orgFullName);
    case 'level1':
      return text(row.orgLevels?.[0]);
    case 'level2':
      return text(row.orgLevels?.[1]);
    case 'level3':
      return text(row.orgLevels?.[2]);
    case 'department':
      return text(row.departmentName);
  }
}
