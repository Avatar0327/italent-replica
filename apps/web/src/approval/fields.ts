import { normalizeUuid } from '@italent/domain';
import { fieldLabels } from './messages.js';
import type { FieldDraft } from './types.js';

/** DEC-045：字段展示与输入校验文案集中为资源。 */
export const fieldText = {
  fields: '本节点可见字段',
  original: '原值',
  current: '当前值',
  empty: '—',
  yes: '是',
  no: '否',
  clear: (field: string) => `清空 ${field}`,
  invalidNumber: '请输入有效的数字',
  invalidBoolean: '请选择有效的是或否',
  invalidArray: '请输入只含原有元素类型的 JSON 数组',
  invalidUuid: '请输入有效的 UUID',
  invalidValue: '字段值的类型不正确',
  invalidDate: '日期必须为合法 YYYY-MM-DD，生效日期不能清空',
  invalidScalar: '请输入 JSON 标量：文本、有限数字、true、false 或 null',
  scalarHint: '以 JSON 标量填写：文本使用双引号，数字、true、false、null 不加引号。',
  invalidUuidArray: '请输入最多 100 个不重复 UUID 的 JSON 数组',
  labels: fieldLabels,
} as const;

export interface FieldLeaf {
  readonly path: readonly string[];
  readonly value: unknown;
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const safePath = (path: readonly string[]) =>
  path.length > 0 && path.every((key) => key.length > 0 && key.split('.').every((part) => !forbidden.has(part)));
export const fieldKey = (path: readonly string[]): string => JSON.stringify(path);
const primitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const fieldCode = (path: readonly string[]) => path.at(-1)?.split('.').at(-1) ?? '';

/** 类型来自既有 employment/fields.ts；详情元数据不会扩展披露流程或业务配置。 */
const booleanFields = new Set(['isKeyPerson', 'isDepartmentHead', 'isStoreManager']);
const dateFields = new Set([
  'effectiveDate',
  'lastWorkDate',
  'signingDate',
  'endDate',
  'actualTerminationDate',
  'probationStartDate',
  'probationEndDate',
  'onTrialStartDate',
]);
const textFields = new Set([
  'place',
  'employmentType',
  'employmentSource',
  'employmentForm',
  'dimension1',
  'dimension2',
  'dimension3',
  'dimension4',
  'dimension5',
  'jobNumber',
  'remarks',
  'reason',
  'employType',
]);
export type FieldKind = 'text' | 'number' | 'boolean' | 'date' | 'uuid' | 'uuidArray' | 'scalar' | 'array';

export function fieldKind(path: readonly string[], value: unknown): FieldKind {
  const code = fieldCode(path);
  if (booleanFields.has(code)) return 'boolean';
  if (dateFields.has(code)) return 'date';
  if (/Ids$/.test(code)) return 'uuidArray';
  if (/Id$/.test(code)) return 'uuid';
  if (textFields.has(code)) return 'text';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return value === null ? 'scalar' : 'text';
}

export const allowFieldClear = (path: readonly string[]) => fieldCode(path) !== 'effectiveDate';

/** 点号属于服务端字段编码；只有真实对象产生多层路径。数组作为整片只读 / 类型受限叶子处理。 */
export function fieldLeaves(values: Readonly<Record<string, unknown>>): FieldLeaf[] {
  const leaves: FieldLeaf[] = [];
  const walk = (source: Readonly<Record<string, unknown>>, path: readonly string[]) => {
    for (const [key, value] of Object.entries(source)) {
      const next = [...path, key];
      if (!safePath(next)) continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        walk(value as Record<string, unknown>, next);
      else leaves.push({ path: next, value });
    }
  };
  walk(values, []);
  return leaves;
}

export function editableLeaf(path: readonly string[], editableFields: readonly string[]): boolean {
  if (!safePath(path)) return false;
  return path.some((_, index) => editableFields.includes(path.slice(0, index + 1).join('.')));
}

/** 对象数组没有逐叶子编辑契约；空数组缺少元素类型信息，均保持只读。 */
export function editableValue(value: unknown, path: readonly string[] = []): boolean {
  if (fieldKind(path, value) === 'uuidArray') return value === null || (Array.isArray(value) && value.every(primitive));
  return Array.isArray(value)
    ? value.length > 0 && value.every(primitive) && value.some((item) => item !== null)
    : primitive(value);
}

function cleanDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanDisplay);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => safePath([key]))
        .map(([key, item]) => [key, cleanDisplay(item)]),
    );
  return value;
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return fieldText.empty;
  if (typeof value === 'boolean') return value ? fieldText.yes : fieldText.no;
  return typeof value === 'object' ? JSON.stringify(cleanDisplay(value)) : String(value);
}

function arrayValue(value: unknown, original: readonly unknown[]): unknown[] {
  const types = new Set(original.filter((item) => item !== null).map((item) => typeof item));
  if (
    !editableValue(original) ||
    !Array.isArray(value) ||
    !value.every((item) => primitive(item) && (item === null || types.has(typeof item)))
  )
    throw new Error(fieldText.invalidArray);
  return value;
}

function isoDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-'))
    throw new Error(fieldText.invalidDate);
  const day = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value)
    throw new Error(fieldText.invalidDate);
  return value;
}

function uuidArrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === 'string'))
    throw new Error(fieldText.invalidUuidArray);
  return value;
}

function scalarValue(value: unknown): unknown {
  if (!primitive(value) || (typeof value === 'number' && !Number.isFinite(value)))
    throw new Error(fieldText.invalidScalar);
  return value;
}

function jsonDraft(input: string, original: unknown, kind: FieldKind): unknown {
  try {
    const value: unknown = JSON.parse(input);
    if (kind === 'uuidArray') return uuidArrayValue(value);
    return kind === 'scalar' ? scalarValue(value) : arrayValue(value, original as readonly unknown[]);
  } catch {
    throw new Error(kind === 'scalar' ? fieldText.invalidScalar : fieldText.invalidArray);
  }
}

export function valueDraft(input: string, original: unknown, path: readonly string[] = []): unknown {
  const kind = fieldKind(path, original);
  if (kind === 'uuidArray' || kind === 'array' || kind === 'scalar') {
    try {
      return jsonDraft(input, original, kind);
    } catch {
      throw new Error(kind === 'scalar' ? fieldText.invalidScalar : fieldText.invalidArray);
    }
  }
  if (kind === 'date') return isoDate(input);
  if (kind === 'number') {
    const value = Number(input);
    if (!input.trim() || !Number.isFinite(value)) throw new Error(fieldText.invalidNumber);
    return value;
  }
  if (kind === 'boolean') {
    if (input === '') return null;
    if (input !== 'true' && input !== 'false') throw new Error(fieldText.invalidBoolean);
    return input === 'true';
  }
  if (kind === 'text' || kind === 'uuid') return input;
  throw new Error(fieldText.invalidValue);
}

function draftValue(value: unknown, original: unknown, path: readonly string[]): unknown {
  if (value === null) {
    if (!allowFieldClear(path)) throw new Error(fieldText.invalidDate);
    return null;
  }
  if (!editableValue(original, path)) throw new Error(fieldText.invalidValue);
  const kind = fieldKind(path, original);
  if (kind === 'date') return isoDate(value);
  if (kind === 'uuidArray') return uuidArrayValue(value);
  if (kind === 'array') return arrayValue(value, original as readonly unknown[]);
  if (kind === 'scalar') return scalarValue(value);
  if (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (kind === 'boolean' && typeof value === 'boolean') return value;
  if ((kind === 'text' || kind === 'uuid') && typeof value === 'string') return value;
  throw new Error(fieldText.invalidValue);
}

function normalizeField(path: readonly string[], value: unknown): unknown {
  const code = fieldCode(path);
  if (value === null) return null;
  if (/Id$/.test(code) && typeof value === 'string') {
    const id = normalizeUuid(value);
    if (!id) throw new Error(fieldText.invalidUuid);
    return id;
  }
  if (/Ids$/.test(code) && Array.isArray(value)) {
    const ids = value.map((item) => {
      const id = typeof item === 'string' && normalizeUuid(item);
      if (!id) throw new Error(fieldText.invalidUuid);
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new Error(fieldText.invalidUuidArray);
    return ids;
  }
  return value;
}

function putLeaf(target: Record<string, unknown>, path: readonly string[], value: unknown) {
  let parent = target;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  parent[path.at(-1)!] = value;
}

/** 只提交当前返回且仍允许编辑的变化叶子；不会用完整对象回填未披露的同级字段。 */
export function buildFieldEdits(
  values: Readonly<Record<string, unknown>>,
  draft: FieldDraft,
  editableFields: readonly string[],
): Record<string, unknown> {
  const visible = new Map(fieldLeaves(values).map((leaf) => [fieldKey(leaf.path), leaf]));
  const fields: Record<string, unknown> = {};
  for (const [key, edit] of Object.entries(draft)) {
    const leaf = visible.get(key);
    if (
      !leaf ||
      key !== fieldKey(edit.path) ||
      !editableLeaf(leaf.path, editableFields) ||
      !editableValue(leaf.value, leaf.path)
    )
      continue;
    const value = normalizeField(leaf.path, draftValue(edit.value, leaf.value, leaf.path));
    if (JSON.stringify(value) !== JSON.stringify(leaf.value)) putLeaf(fields, leaf.path, value);
  }
  return fields;
}
