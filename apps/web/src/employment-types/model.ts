/**
 * 人员类别字典的纯规则（F-323b；后端 apps/api/src/modules/employment/employment-type-routes.ts）。
 * 不依赖 React 或浏览器 API；权威校验在服务端。
 */
import type { ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export const EMPLOYMENT_TYPE_OBJECT = 'TenantBase.EmploymentType';
export const TYPES_PATH = '/api/tenant/employment/employment-types';
export const OPTIONS_PATH = `${TYPES_PATH}/options`;
export const VIEWS = ['enabled', 'disabled', 'all'] as const;
export type View = (typeof VIEWS)[number];
export const ORDER_MAX = 100000;
export const NAME_MAX = 200;
export const listPath = (view: View) => `${TYPES_PATH}?view=${view}`;
export const rowPath = (id: string, action?: 'disable' | 'enable') =>
  `${TYPES_PATH}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
/** 表单字段（与后端 parseEmploymentType 一致）；状态只经停用 / 启用按钮改。 */
export const typeFields = ['name', 'displayOrder', 'effectiveDate', 'expiryDate'] as const;

// 类型别名：可直接作为内核的 Values 投影。字段可能被查看权裁掉，只有 id / 版本必有。
export type TypeRow = {
  id: string;
  revision: number;
  name?: string;
  displayOrder?: number;
  effectiveDate?: string;
  expiryDate?: string | null;
  enabled?: boolean;
};
const isRow = (raw: unknown): raw is TypeRow => {
  const row = raw as Partial<TypeRow> | null;
  return !!row && typeof row.id === 'string' && row.id !== '' && Number.isSafeInteger(row.revision);
};
export function parseRows(raw: unknown): TypeRow[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isRow)) throw new Error(m.invalidList);
  return items;
}
/** 写回执：整行须是本行（新建不核对 id），版本 = 实际提交的版本 + 1；删除回执是 { id, deleted: true }。 */
export function parseReceipt(raw: unknown, expected: { id?: string; revision: number; deleted?: boolean }) {
  const body = raw as { id?: unknown; revision?: unknown; deleted?: unknown } | null;
  const sameId = !!body && typeof body.id === 'string' && (!expected.id || body.id === expected.id);
  const ok = expected.deleted ? body?.deleted === true : body?.revision === expected.revision + 1;
  if (!sameId || !ok) throw new Error(m.invalidReceipt);
  return { id: body.id as string };
}
/** 新建默认排在当前视图末项之后（顺序号可重复，仅作默认值）。 */
export function nextOrder(rows: readonly TypeRow[]) {
  const last = rows.reduce((max, row) => Math.max(max, row.displayOrder ?? 0), 0);
  return rows.length ? Math.min(ORDER_MAX, last + 10) : 10;
}

/** 按钮按后端授权链：数据操作 + 按钮授权（create@list，其余 @detail）；快照摘要未载入明细时不授予。 */
export function typeActions(permission: ObjectPermission | undefined, row?: TypeRow) {
  const loaded = permission && !permission.summary ? permission : undefined;
  const op = (name: string) => loaded?.dataOperations[name] === true;
  const button = (code: string, level = 'detail') =>
    !!loaded?.buttons.some((item) => item.buttonCode === code && item.level === level);
  const editable = (field: string) => !!loaded?.viewableFields.includes(field) && loaded.editableFields.includes(field);
  return {
    create: op('create') && button('create', 'list') && editable('name') && editable('effectiveDate'),
    edit: !!row && op('update') && button('update') && typeFields.some(editable),
    disable: row?.enabled === true && op('update') && button('disable'),
    enable: row?.enabled === false && op('update') && button('enable'),
    remove: !!row && op('delete') && button('delete'),
    editable,
  };
}
