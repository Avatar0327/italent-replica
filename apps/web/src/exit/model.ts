/**
 * 离职三个字典设置页的纯规则（R2-T03 设计 §2.1、§3；后端 employment/exit-dictionaries.ts）。
 * 本文件被页面登记与 vitest 引用，不依赖 React 或浏览器 API；权威校验仍在服务端。
 */
import { EXIT_DICTIONARY_KINDS, type ExitDictionaryKind } from '@italent/domain';
import type { ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export type Kind = ExitDictionaryKind;
export const KINDS: readonly Kind[] = EXIT_DICTIONARY_KINDS;
export const isKind = (value: string | undefined): value is Kind => (KINDS as readonly string[]).includes(value ?? '');
/** 读取按任职记录查看权（菜单入口对象）；写入按任职设置配置对象授权（exit-routes.ts）。 */
export const EXIT_RECORD_OBJECT = 'TenantBase.EmploymentRecord';
export const EXIT_SETTINGS_OBJECT = 'TenantBase.EmploymentSettings';
export const dictionaryPath = (kind: Kind) => `/api/tenant/employment/exits/dictionaries/${kind}`;
/** 与后端 createInput / updateInput 一致。 */
export const ORDER_MAX = 100000;
export const CODE_MAX = 100;
export const NAME_MAX = 200;

// 类型别名而非接口：可直接作为内核的 Values 投影。
export type Entry = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  displayOrder: number;
  revision: number;
};
export const entryFields = ['code', 'name', 'enabled', 'displayOrder'] as const;
/** 编码保存后不可改（§2.1）：修改不提交编码。 */
const updatable = ['name', 'enabled', 'displayOrder'] as const;

const isEntry = (raw: unknown): raw is Entry => {
  const row = raw as Partial<Entry> | null;
  return (
    !!row &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    typeof row.code === 'string' &&
    typeof row.name === 'string' &&
    typeof row.enabled === 'boolean' &&
    Number.isSafeInteger(row.displayOrder) &&
    Number.isSafeInteger(row.revision) &&
    row.revision! >= 1
  );
};
/** 列表整份返回（每个字典上限 500，不分页）；形态不对按读取失败处理，不当作空字典。 */
export function parseEntries(raw: unknown): Entry[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isEntry)) throw new Error(m.invalidList);
  return items;
}
/** 新增 / 修改回执是整行：须是本行（新增不核对 id），版本 = 实际提交的版本 + 1。 */
export function parseEntryReceipt(raw: unknown, expected: { id?: string; revision: number }) {
  if (!isEntry(raw) || (expected.id && raw.id !== expected.id) || raw.revision !== expected.revision + 1)
    throw new Error(m.invalidReceipt);
  return { id: raw.id };
}

/**
 * 写能力只看任职设置对象的数据操作与可编辑字段（配置对象 /me/objects 没有按钮）；快照摘要未懒加载明细时不授予。
 * 新增须编码、名称都可编辑；修改按字段逐项判断（改名 / 启停 / 调序各看各的字段）。
 */
export function writeAccess(permission?: ObjectPermission) {
  const loaded = permission && !permission.summary ? permission : undefined;
  const editable = (field: string) =>
    !!loaded && loaded.viewableFields.includes(field) && loaded.editableFields.includes(field);
  const createFields = loaded?.dataOperations.create === true ? entryFields.filter(editable) : [];
  const create = createFields.includes('code') && createFields.includes('name');
  return {
    create,
    createFields: create ? createFields : [],
    updateFields: loaded?.dataOperations.update === true ? updatable.filter(editable) : [],
  };
}
export type WriteAccess = ReturnType<typeof writeAccess>;

/** 新增默认排在最后：末项显示顺序 + 10，不超过上限。 */
export function nextOrder(rows: readonly Entry[]) {
  const last = rows.reduce((max, row) => Math.max(max, row.displayOrder), 0);
  return rows.length ? Math.min(ORDER_MAX, last + 10) : 10;
}

/**
 * 上移 / 下移只改本条显示顺序（没有批量重排接口）：取严格落在越过的那条与再往外一条之间的值，
 * 不依赖同显示顺序时的编码排序（数据库排序规则前端无法复现）。
 * 返回 undefined 表示没有可越过的一条（不提供按钮）；null 表示没有空位或越界，由页面提示改显示顺序。
 */
export function moveTarget(rows: readonly Entry[], index: number, step: -1 | 1): number | null | undefined {
  const near = rows[index + step]?.displayOrder;
  if (near === undefined) return undefined;
  const beyond = rows[index + 2 * step]?.displayOrder;
  if (beyond !== undefined) {
    const gap = (near - beyond) * -step;
    return gap >= 2 ? beyond + Math.floor(gap / 2) * -step : null;
  }
  if (step < 0) return near > 0 ? Math.max(0, near - 10) : null;
  return near < ORDER_MAX ? Math.min(ORDER_MAX, near + 10) : null;
}

/** 编码重复按编码比较（后端不分大小写），不靠拒绝原因的文案。 */
export const sameCode = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
