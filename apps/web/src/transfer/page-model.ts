import type { TransferListRow } from '../demo-stubs/transfer.js';
import { bannerText, columnText, listText as t, text } from './messages.js';

/**
 * 调动管理列表的页面结构（纯数据，单测直接核对）：视图、工具栏、提示、快捷筛选与列序都按原站各视图（DEC-489）。
 * 没有接口的工具保留位置但禁用（DEC-456）；列表仍是合成演示数据。
 */
export type TransferView = 'progress' | 'completed' | 'all';
export const transferViews: readonly { key: TransferView; label: string }[] = [
  { key: 'progress', label: text.inProgress },
  { key: 'completed', label: text.completed },
  { key: 'all', label: text.allRecords },
];
export const isTransferView = (value: string | null): value is TransferView =>
  transferViews.some((view) => view.key === value);

export type TransferTool = 'process' | 'apply' | 'direct' | 'batch' | 'more' | 'export' | 'import';
export const transferTools: Record<TransferView, readonly TransferTool[]> = {
  progress: ['process', 'apply', 'direct', 'batch', 'more'],
  completed: ['process', 'apply', 'direct', 'batch', 'export'],
  all: ['apply', 'direct', 'batch', 'export', 'import'],
};
/** 原站这几项是下拉按钮；只有“他人调动申请”“调动”有现成表单可打开。 */
export const dropdownTools: readonly TransferTool[] = ['process', 'more', 'export', 'import'];
export const enabledTools: readonly TransferTool[] = ['apply', 'direct'];
export const toolLabels: Record<TransferTool, string> = {
  process: t.process,
  apply: t.apply,
  direct: t.direct,
  batch: t.batch,
  more: t.more,
  export: t.export,
  import: t.import,
};

export const transferBanners: Record<TransferView, { lines: readonly string[]; link: string }> = {
  progress: { lines: bannerText.progress, link: t.faq },
  completed: { lines: bannerText.completed, link: t.learnMore },
  all: { lines: bannerText.all, link: t.learnMore },
};

export type TransferFilterKey = 'person' | 'date' | 'department' | 'post' | 'status';
export const transferFilters: Record<TransferView, readonly TransferFilterKey[]> = {
  progress: ['person', 'date', 'department', 'post', 'status'],
  completed: ['person', 'date', 'department', 'post'],
  all: ['person', 'date', 'department', 'post', 'status'],
};
/** 原站调动中视图没有“清空已选”入口，另两个视图有。 */
export const clearableViews: readonly TransferView[] = ['completed', 'all'];

export type TransferColumn = Exclude<keyof TransferListRow, 'id'> | 'operation';
export const transferColumns: Record<TransferView, readonly TransferColumn[]> = {
  progress: [
    ...['name', 'code', 'effectiveDate', 'type', 'beforeDepartment', 'beforePosition'],
    ...['organization', 'department', 'place', 'position', 'handover', 'status', 'approver', 'operation'],
  ] as TransferColumn[],
  completed: [
    ...['name', 'code', 'effectiveDate', 'type', 'beforeOrgFullName', 'beforeOrganization', 'beforeJob'],
    ...['beforeLevelCategory', 'orgFullName', 'organization', 'job', 'levelCategory', 'handover', 'status'],
    'operation',
  ] as TransferColumn[],
  all: [
    ...['name', 'code', 'effectiveDate', 'type', 'beforeDepartment', 'beforePosition', 'organization'],
    ...['department', 'place', 'position', 'status', 'approver', 'operation'],
  ] as TransferColumn[],
};
export const columnLabels: Record<TransferColumn, string> = columnText;
export const statusLabels: Record<TransferListRow['status'], string> = {
  running: text.running,
  approved: text.approved,
  effective: text.effectiveStatus,
};

export interface TransferFilterValues {
  person?: string;
  from?: string;
  to?: string;
  department?: string;
  post?: string;
  status?: TransferListRow['status'];
  beforeDepartment?: string;
  beforePost?: string;
}
const inView = (row: TransferListRow, view: TransferView) =>
  view === 'all' || (view === 'completed') === (row.status === 'effective');
const matches = (value: string, wanted?: string) => !wanted || value === wanted;
/** 只作用于合成数据；真实列表接口补齐后改由服务端筛选（后端缺口清单）。 */
export function filterTransfers(rows: readonly TransferListRow[], view: TransferView, filters: TransferFilterValues) {
  const person = filters.person?.trim() ?? '';
  return rows.filter(
    (row) =>
      inView(row, view) &&
      `${row.name} ${row.code}`.includes(person) &&
      (!filters.from || row.effectiveDate >= filters.from) &&
      (!filters.to || row.effectiveDate <= filters.to) &&
      matches(row.department, filters.department) &&
      matches(row.position, filters.post) &&
      matches(row.beforeDepartment, filters.beforeDepartment) &&
      matches(row.beforePosition, filters.beforePost) &&
      matches(row.status, view === 'completed' ? undefined : filters.status),
  );
}
