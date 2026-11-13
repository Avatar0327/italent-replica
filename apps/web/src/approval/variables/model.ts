/**
 * 公共变量 / 应用变量管理页的纯规则（F-326 F1；后端 apps/api/src/modules/approval/variable-routes.ts）。
 * 不依赖 React 或浏览器 API；权威校验在服务端，这里只做形态核对与提交体换算。
 */
import {
  APPROVAL_VARIABLE_APPS,
  APPLICATION_VARIABLE_PREFIX,
  PUBLIC_VARIABLE_PREFIX,
  VARIABLE_USAGE_SCOPES,
  statusAfter,
  type VariableDataType,
  type VariableStatus,
} from '@italent/domain';
import { m, type ScopeKind } from './messages.js';

export const VARIABLES_PATH = '/api/tenant/approval/variables';
export const PEOPLE_PATH = '/api/tenant/approval/designer/person-candidates';
export const PAGE_SIZE = 50;
export const TABS = ['active', 'disabled'] as const;
export type Tab = (typeof TABS)[number];
/** 编辑表单可改的字段；编码、数据类型、作用域建后锁定（后端 PATCH 要求与现值一致），状态只经启停按钮改。 */
export const EDIT_FIELDS = ['name', 'defaultValue', 'usageScopes', 'description'] as const;

export interface Person {
  userId: string;
  name: string;
  code: string | null;
  departmentName: string | null;
}
// 类型别名：可直接作为内核的 Values 投影。
export type VariableRow = {
  id: string;
  revision: number;
  scope: ScopeKind;
  appId: string | null;
  code: string;
  name: string;
  dataType: VariableDataType;
  defaultValue: unknown;
  usageScopes: string[];
  description: string | null;
  status: VariableStatus;
  updatedBy: string | null;
  updatedAt: string;
  people: Person[];
};
export interface Reference {
  processId: string;
  processCode: string;
  processName: string;
  approvalType: string;
  versionKind: string;
  versionNo: number;
  nodeKey: string;
  nodeName: string;
  position: string;
  columnId: string | null;
  instanceCount: number | null;
}

export const prefixOf = (scope: ScopeKind) =>
  scope === 'public' ? PUBLIC_VARIABLE_PREFIX : APPLICATION_VARIABLE_PREFIX;

/** 应用变量页共用一个组件：应用取自路由末段 app-variables-<app>，不在登记表外另传参数。 */
export function appFromPath(pathname: string): string | undefined {
  const app = /\/app-variables-([a-z-]+)(?:\/|$)/.exec(pathname)?.[1];
  return app && (APPROVAL_VARIABLE_APPS as readonly string[]).includes(app) ? app : undefined;
}

export function listPath(scope: ScopeKind, app: string | undefined, tab: Tab, offset: number) {
  const query = new URLSearchParams({ scope, ...(app ? { appId: app } : {}), status: tab });
  query.set('offset', String(offset));
  query.set('limit', String(PAGE_SIZE));
  return `${VARIABLES_PATH}?${query}`;
}
export const rowPath = (id: string, action?: 'enable' | 'disable' | 'references') =>
  `${VARIABLES_PATH}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

const isRow = (raw: unknown): raw is VariableRow => {
  const row = raw as Partial<VariableRow> | null;
  return (
    !!row &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    Number.isSafeInteger(row.revision) &&
    typeof row.code === 'string' &&
    typeof row.dataType === 'string' &&
    typeof row.status === 'string' &&
    Array.isArray(row.usageScopes) &&
    Array.isArray(row.people)
  );
};
export function parseRow(raw: unknown): VariableRow {
  if (!isRow(raw)) throw new Error(m.invalidList);
  return raw;
}
export function parsePage(raw: unknown): { items: VariableRow[]; total: number } {
  const body = raw as { items?: unknown; total?: unknown } | null;
  if (!Array.isArray(body?.items) || !body.items.every(isRow) || !Number.isSafeInteger(body.total))
    throw new Error(m.invalidList);
  return { items: body.items, total: body.total as number };
}
/** 写回执：整行须是本行（新建不核对 id），版本 = 实际提交的版本 + 1。 */
export function parseReceipt(raw: unknown, expected: { id?: string; revision: number }) {
  const body = raw as { id?: unknown; revision?: unknown } | null;
  const sameId = !!body && typeof body.id === 'string' && (!expected.id || body.id === expected.id);
  if (!sameId || body.revision !== expected.revision + 1) throw new Error(m.invalidReceipt);
  return { id: body.id as string };
}
export function parseReferences(raw: unknown): { items: Reference[]; total: number } {
  const body = raw as { items?: unknown; total?: unknown } | null;
  const valid = (item: unknown) => {
    const ref = item as Partial<Reference> | null;
    return !!ref && typeof ref.processId === 'string' && typeof ref.nodeKey === 'string';
  };
  if (!Array.isArray(body?.items) || !body.items.every(valid) || !Number.isSafeInteger(body.total))
    throw new Error(m.invalidReferences);
  return { items: body.items as Reference[], total: body.total as number };
}
export const referenceKey = (ref: Reference) =>
  [ref.processId, ref.versionKind, ref.versionNo, ref.nodeKey, ref.position, ref.columnId ?? ''].join(':');

/** 行操作按状态（规格 30 §三）：启用中 编辑 / 停用 / ▾查看引用；停用中 编辑 / 启用。草稿按状态机可启用不可停用（未验证）。 */
export function rowActions(status: VariableStatus) {
  return {
    enable: statusAfter(status, 'enable') !== null,
    disable: statusAfter(status, 'disable') !== null,
    references: status !== 'disabled',
  };
}

/** 适用范围按规格顺序排列；三项全选即「全部」。 */
export const orderedScopes = (scopes: readonly string[]) => VARIABLE_USAGE_SCOPES.filter((s) => scopes.includes(s));
export const isAllScopes = (scopes: readonly string[]) => orderedScopes(scopes).length === VARIABLE_USAGE_SCOPES.length;
/** 公共变量把「流程」移出适用范围会让引用它的节点取不到审批人，须与停用一样先看影响（设计 §6.2）。 */
export const removesProcess = (before: readonly string[], after: unknown) =>
  before.includes('process') && Array.isArray(after) && !after.includes('process');

/** 默认值：表单里的空值统一为 null（未设置）；整数控件给 number，其余按后端形态原样。 */
export function defaultValueOf(dataType: VariableDataType, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (dataType === 'persons') return Array.isArray(value) && value.length ? value : null;
  if (dataType === 'string' || dataType === 'decimal' || dataType === 'datetime') return String(value);
  return value;
}

/** 新建提交体：应用变量不带适用范围与描述（后端要求空集与 null）；未填的可选项不发。 */
export function createBody(scope: ScopeKind, app: string | undefined, values: Record<string, unknown>) {
  const dataType = values.dataType as VariableDataType;
  const defaultValue = defaultValueOf(dataType, values.defaultValue);
  const description = typeof values.description === 'string' && values.description !== '' ? values.description : null;
  return {
    scope,
    ...(scope === 'application' ? { appId: app } : {}),
    codeSuffix: values.codeSuffix,
    name: values.name,
    dataType,
    ...(defaultValue === null ? {} : { defaultValue }),
    ...(scope === 'public' ? { usageScopes: orderedScopes(values.usageScopes as string[]) } : {}),
    ...(scope === 'public' && description !== null ? { description } : {}),
    enable: values.enable === 'enabled',
  };
}

/** 编辑：表单值换成与行同形的值，交给内核按基线算改动字段（只发改过的）。 */
export function editValues(row: VariableRow, values: Record<string, unknown>) {
  const result: Record<string, unknown> = {
    name: values.name,
    defaultValue: defaultValueOf(row.dataType, values.defaultValue),
  };
  if (row.scope === 'public') {
    result.usageScopes = orderedScopes(values.usageScopes as string[]);
    result.description =
      typeof values.description === 'string' && values.description !== '' ? values.description : null;
  }
  return result;
}
