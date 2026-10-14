import { EMPLOYEE_SELF_SERVICE_BUTTONS } from '@italent/domain';
import { pageQuery, type PageRequest } from '../../foundation/client.js';
import type { OwnRecord } from '../../employee-self-service/types.js';
import { presetLabels } from '../../transfer/messages.js';
import { messages as m } from './messages.js';

export const SELF = '/api/tenant/self-service';
export const MANAGER = '/api/tenant/employment/transfers/manager';
export type TeamRow = Record<string, unknown> & { display?: Record<string, unknown> };
export interface TodoRow {
  id?: string;
  taskId?: string;
  instanceId?: string;
  title: string;
  status?: string;
  nodeName?: string;
  createdAt?: string | null;
}
export const teamLabels: Record<string, string> = { ...m.manager.columns, email: m.email };
export function canApplySelf(can: (button: string, level: string) => boolean) {
  return EMPLOYEE_SELF_SERVICE_BUTTONS.every(({ buttonCode, level }) => can(buttonCode, level));
}
export function statusText(value?: string) {
  return m.manager.statuses[value as keyof typeof m.manager.statuses] ?? value ?? m.none;
}
export function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return m.none;
  if (typeof value === 'boolean') return value ? m.manager.leavingYes : m.manager.leavingNo;
  if (Array.isArray(value)) return value.map(valueText).join('、');
  if (typeof value === 'object') return m.none;
  return String(value);
}
export function recordItems(record: OwnRecord) {
  const dates = [
    { key: 'effectiveDate', label: m.start, children: record.effectiveDate },
    { key: 'stopDate', label: m.end, children: record.stopDate },
    { key: 'approvalStatus', label: m.approval, children: record.approvalStatus },
  ].filter((item) => item.children !== undefined);
  return [
    ...dates.map((item) => ({
      ...item,
      children: item.key === 'approvalStatus' ? statusText(item.children ?? undefined) : valueText(item.children),
    })),
    ...Object.keys(record.fields)
      .filter((key) => presetLabels[key])
      .map((key) => ({
        key,
        label: presetLabels[key]!,
        children: teamValue({ ...record.fields, display: record.fieldLabels }, key),
      })),
  ];
}
export function teamKeys(rows: TeamRow[]) {
  return Object.keys(teamLabels).filter((key) => rows.some((row) => Object.hasOwn(row, key)));
}
export function teamValue(row: TeamRow, key: string) {
  if (!Object.hasOwn(row, key)) return m.none;
  const value = row.display?.[key] ?? row[key];
  // AGENTS §10：仅未解析的引用 ID 用占位，业务编码即使形似 UUID 也须原样显示。
  if (key.endsWith('Id') && value === row[key] && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value))) return m.none;
  const labels =
    (
      {
        employeeStatus: m.manager.employeeStatuses,
        entryStatus: m.manager.entryStatuses,
        employType: m.manager.employTypes,
      } as Record<string, Record<string, string>>
    )[key] ?? {};
  return labels[String(value)] ?? valueText(value);
}
export function managerListPath(kind: 'team' | 'todos', page: PageRequest, category: string, search = '') {
  const query = pageQuery(page);
  if (kind === 'team') {
    if (category) query.set('category', category);
    if (search.trim()) query.set('search', search.trim());
  } else query.set('tab', category);
  return `${MANAGER}/${kind}?${query}`;
}
export function instant(value: string | null | undefined, timezone: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: timezone }) : m.none;
}
