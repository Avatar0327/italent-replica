import type { PageRequest } from '../foundation/client.js';
import { m } from './messages.js';

export type Row = { id: string; [field: string]: unknown };
export type Filters = { name?: string; code?: string; entryDate?: string; employeeStatus?: string };
/**
 * 原站默认已选：员工姓名、员工ID、（机构ID、组织全称、雇佣关系、职位）、首次参加工作日期、性别、入职日期……
 * 括号内字段列表接口暂未返回（见后端缺口），入职日期之后的复刻字段排序未与原站逐项核对。
 */
export const defaultColumns = [
  'name',
  'code',
  'workDate',
  'gender',
  'entryDate',
  'employeeStatus',
  'firstEntryDate',
  'email',
];
/** 列表接口已返回的人员字段都可选；证件号码等敏感字段不进列表候选。 */
export const columnChoices = [
  ...defaultColumns,
  'educationLevel',
  'lastSchool',
  'major',
  'graduateDate',
  'mobilePhone',
  'officePhone',
  'workEmail',
  'backupMail',
  'latestEntryDate',
  'lastWorkDate',
  'birthday',
  'age',
  'nation',
  'nationality',
  'marryCategory',
  'politicalStatus',
];
/** 列表与设置显示字段用原站列名（如“首次参加工作日期”），档案里用原站字段名（“参加工作日期”）。 */
export function columnLabel(key: string) {
  return m.columnLabels[key] ?? m.labels[key] ?? key;
}
/** 员工姓名是列表打开档案的入口，原站在“设置显示字段”里锁定首位，不可取消、不可拖动。 */
export const lockedColumn = 'name';
export function visibleColumns(selected: readonly string[], allowed: readonly string[]) {
  return selected.filter((key) => allowed.includes(key));
}
/** 原站“设置显示字段”：新勾选的字段排到已选末尾，顺序由右栏拖拽决定。 */
export function toggleColumn(selected: readonly string[], key: string, checked: boolean): string[] {
  if (key === lockedColumn || !columnChoices.includes(key)) return [...selected];
  if (!checked) return selected.filter((item) => item !== key);
  return selected.includes(key) ? [...selected] : [...selected, key];
}
export function toggleColumnGroup(selected: readonly string[], keys: readonly string[], checked: boolean): string[] {
  if (!checked) return selected.filter((key) => key === lockedColumn || !keys.includes(key));
  return [...selected, ...keys.filter((key) => !selected.includes(key) && columnChoices.includes(key))];
}
export function columnGroupState(selected: readonly string[], keys: readonly string[]) {
  const optional = keys.filter((key) => key !== lockedColumn);
  const count = optional.filter((key) => selected.includes(key)).length;
  return { checked: count > 0 && count === optional.length, indeterminate: count > 0 && count < optional.length };
}
/** 拖到目标项的位置；员工姓名固定首位，其他字段不能越过它。 */
export function moveColumn(selected: readonly string[], key: string, target: string): string[] {
  const from = selected.indexOf(key);
  const to = selected.indexOf(target);
  if (key === lockedColumn || from < 0 || to < 0 || from === to) return [...selected];
  const next = selected.filter((item) => item !== key);
  const floor = next[0] === lockedColumn ? 1 : 0;
  next.splice(Math.max(to, floor), 0, key);
  return next;
}
export function restoreDefaultColumns() {
  return [...defaultColumns];
}
export function matchColumns(keys: readonly string[], keyword: string) {
  const text = keyword.trim();
  return text ? keys.filter((key) => columnLabel(key).includes(text)) : [...keys];
}
export function employeeQuery(filters: Filters, page: PageRequest, allowed: readonly string[]) {
  const params = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) });
  for (const key of ['name', 'code', 'entryDate', 'employeeStatus'] as const) {
    const value = filters[key]?.trim();
    if (value && allowed.includes(key)) params.set(key === 'name' ? 'employeeName' : key, value);
  }
  return params.toString();
}
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return m.empty;
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return m.empty;
}
/** 原站档案与任职卡片的日期写“2021年7月1日”，列表仍是 ISO 写法。 */
export function longDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : value;
}
export function fieldValue(key: string, value: unknown, format?: 'long') {
  if (key === 'employeeStatus' && typeof value === 'number') return m.statuses[value] ?? displayValue(value);
  if (format === 'long' && typeof value === 'string') return longDate(value);
  return displayValue(value);
}
/** 原站任职记录卡片写“开始 至 结束”（年月日），无截止日期（9999-12-31）写“至今”。 */
export function recordPeriod(row: { effectiveDate?: unknown; stopDate?: unknown }) {
  const from = fieldValue('effectiveDate', row.effectiveDate, 'long');
  if (row.stopDate === '9999-12-31') return `${from} ${m.untilNow}`;
  return `${from} ${m.until} ${fieldValue('stopDate', row.stopDate, 'long')}`;
}
/**
 * 原站“人员信息”页签人员字段合在一个“员工信息”分区，二列排布；前 18 项按原站顺序（截图到联系地址为止）。
 * 之后的字段原站未截全，复刻接着列出原有分区里的其余字段，顺序未验证。籍贯、QQ、微信后端暂无字段。
 */
export const profileSections = [
  {
    key: 'basic',
    title: m.employeeInfo,
    fields: [
      'name',
      'engName',
      'email',
      'educationLevel',
      'workDate',
      'idType',
      'idNumber',
      'birthday',
      'gender',
      'nationality',
      'nation',
      'marryCategory',
      'politicalStatus',
      'householdCategory',
      'registAddress',
      'officePhone',
      'mobilePhone',
      'contactAddress',
      'code',
      'age',
      'workEmail',
      'backupMail',
      'emergencyContact',
      'emergencyPhone',
      'lastSchool',
      'major',
      'graduateDate',
      'employeeStatus',
      'entryDate',
      'firstEntryDate',
      'latestEntryDate',
      'lastWorkDate',
    ],
  },
];
