import { ApiError } from '../foundation/client.js';
import { messages as commandMessages } from '../foundation/forms/messages.js';
import type { ProjectAction, ReviewRecord } from './types.js';
import { tr } from './messages.js';
export function projectActions(row: ReviewRecord, can: (button: string) => boolean): ProjectAction[] {
  if (row.accessLevel !== 'manage' || !Number.isInteger(row.revision)) return [];
  const actions: Record<string, ProjectAction[]> = {
    new: ['update', 'start', 'end'],
    in_progress: ['update', 'end'],
    ended: ['restart'],
  };
  return (actions[row.status ?? ''] ?? []).filter((button) => can(button));
}
const writable = [
  'code',
  'name',
  'ownerOrgId',
  'year',
  'period',
  'periodStartDate',
  'periodEndDate',
  'businessDate',
  'categoryId',
  'criterionId',
  'calcRuleId',
  'downwardPublic',
  'carryLastResult',
  'sharedOrgIds',
];
export function projectInput(
  values: Record<string, unknown>,
  editable: string[],
  initial: Record<string, unknown> = {},
) {
  const body: Record<string, unknown> = {};
  for (const key of writable) {
    if (!editable.includes(key) || !(key in values)) continue;
    let value = values[key];
    if (typeof value === 'string') value = value.trim();
    if (key.endsWith('Id') && typeof value === 'string') value = value.toLowerCase();
    if (['categoryId', 'criterionId', 'calcRuleId', 'businessDate'].includes(key) && !value) value = null;
    body[key] = value;
  }
  const start = body.periodStartDate ?? initial.periodStartDate;
  const end = body.periodEndDate ?? initial.periodEndDate;
  if (typeof start === 'string' && typeof end === 'string' && start > end)
    throw new ApiError(422, 'VALIDATION_FAILED', 'fields', tr.dateOrder, {
      details: { fieldErrors: { periodEndDate: [tr.dateOrder] } },
    });
  return body;
}
export function filterProjects(rows: ReviewRecord[], view: string, name: string) {
  return rows.filter(
    (row) =>
      (view === 'all' ||
        (view === 'ended' ? row.status === 'ended' : ['new', 'in_progress'].includes(row.status ?? ''))) &&
      (!name || row.name?.includes(name.trim())),
  );
}
/** 启用字段的状态文字：只有启用 / 停用两态，读不到时显示 --（不伪造草稿）。 */
export function enabledText(value: unknown) {
  if (typeof value !== 'boolean') return tr.missing;
  return value ? tr.enabled : tr.disabled;
}
export function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return tr.missing;
  if (typeof value === 'boolean') return value ? tr.yes : tr.no;
  return String(value);
}

export interface ReviewFilters {
  name?: string;
  ownerOrgId?: string;
  ownerOrgIds?: string[];
  categoryId?: string;
  year?: number | null;
  startFrom?: string | null;
  startTo?: string | null;
  endFrom?: string | null;
  endTo?: string | null;
  /** 模板状态筛选；字段被裁剪时不参与过滤（DEC-502① d）。 */
  enabled?: boolean;
}
export function matchesFilters(row: ReviewRecord, filters: ReviewFilters, visible: (field: string) => boolean) {
  if (visible('name') && filters.name && !row.name?.includes(filters.name.trim())) return false;
  if (visible('ownerOrgId') && filters.ownerOrgId && row.ownerOrgId !== filters.ownerOrgId) return false;
  if (visible('ownerOrgId') && filters.ownerOrgIds?.length && !filters.ownerOrgIds.includes(row.ownerOrgId ?? ''))
    return false;
  if (visible('enabled') && filters.enabled !== undefined && row.enabled !== filters.enabled) return false;
  if (visible('categoryId') && filters.categoryId && row.categoryId !== filters.categoryId) return false;
  if (visible('year') && filters.year !== null && filters.year !== undefined && row.year !== filters.year) return false;
  for (const [field, from, to] of [
    ['periodStartDate', filters.startFrom, filters.startTo],
    ['periodEndDate', filters.endFrom, filters.endTo],
  ] as const) {
    if (!visible(field) || (!from && !to)) continue;
    const date = row[field];
    if (!date || (from && date < from) || (to && date > to)) return false;
  }
  return true;
}

/** 页面权限的最小形状（usePermissions 返回值）：对象操作权在快照里，按钮按层级判断。 */
export interface WriteAccess {
  can(button: string, level?: string): boolean;
  snapshot: { objects: Record<string, { dataOperations: Readonly<Record<string, boolean>> } | undefined> };
}
/** 写权限按对象操作权 create / update 判断，按钮只决定是否显示服务端返回的动作（DEC-502① c）。 */
export const canOperate = (access: WriteAccess, object: string, operation: 'create' | 'update') =>
  access.snapshot.objects[object]?.dataOperations[operation] === true &&
  access.can(operation, operation === 'create' ? 'list' : 'detail');
/** 模板可编辑：管理权限、版本有效、有 update 操作权与编辑按钮（与后端 accessLevel 一致，不在前端放宽）。 */
export const templateWritable = (row: ReviewRecord, access: WriteAccess, object: string) =>
  row.accessLevel === 'manage' && Number.isInteger(row.revision) && canOperate(access, object, 'update');
/** 配置对象（计算规则）的写权限：设置类对象不带 accessLevel，数据范围由服务端按全部 / 创建人裁剪（DEC-121）。 */
export const configWritable = (row: ReviewRecord, access: WriteAccess, object: string) =>
  Number.isInteger(row.revision) && canOperate(access, object, 'update');
/** 回执须是本对象、版本前进；否则按结果未知锁定，不当成功（DEC-502① a）。 */
export function checkReceipt(receipt: ReviewRecord | undefined, id: string | undefined, revision: number | undefined) {
  if (
    typeof receipt?.id !== 'string' ||
    !receipt.id ||
    (id && receipt.id !== id) ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision! <= (revision ?? 0)
  )
    throw new ApiError(0, 'UNCERTAIN_RECEIPT', 'unknown', commandMessages.unknown);
  return receipt;
}
