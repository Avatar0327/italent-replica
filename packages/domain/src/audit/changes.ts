/**
 * 字段级数据变更（DEC-019；docs/02_业务建模/20 §2、§5 第 1、2 条）：
 * 「变更内容」按原站格式逐字段写「字段名:从【旧值】修改为【新值】」，一次操作的多个字段写在同一行。
 * 新增时旧值为空（或取版本链上一条，由写入方给出 before）；删除时新值为空，完整快照另存在 before。
 */
import { auditFieldLabel } from './labels.js';

export const AUDIT_OPERATIONS = ['create', 'update', 'delete', 'other'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

export const AUDIT_OPERATION_LABELS: Readonly<Record<AuditOperation, string>> = {
  create: '新增',
  update: '编辑',
  delete: '删除',
  other: '其他',
};

/** 写入方给出的字段变更；fromText / toText 是写入时解析出的显示值（引用字段为当时的名称）。 */
export interface AuditFieldChange {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly fromText?: string;
  readonly toText?: string;
}

export interface RenderedAuditChange {
  readonly field: string;
  readonly label: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly fromText: string;
  readonly toText: string;
}

const CREATE_VERBS = new Set(['create', 'insert', 'add', 'initialize', 'provision', 'bootstrap']);
const DELETE_VERBS = new Set(['delete', 'remove', 'exit_delete']);

/** 操作类型：先看动作名的末段（任职“新增记录”的 before 是版本链上一条，不能只看 before 是否为空），再看前后值。 */
export function auditOperationOf(action: string, before: unknown, after: unknown): AuditOperation {
  const verb = action.split('.').at(-1) ?? '';
  if (CREATE_VERBS.has(verb)) return 'create';
  if (DELETE_VERBS.has(verb)) return 'delete';
  if (isNothing(before) && !isNothing(after)) return 'create';
  if (!isNothing(before) && isNothing(after)) return 'delete';
  if ((after as { deleted?: unknown } | null)?.deleted === true) return 'delete';
  if (isNothing(before) && isNothing(after)) return 'other';
  return 'update';
}

/** 不进「变更内容」的技术字段：数据 ID、租户、版本号、时间戳在日志的独立列里，或对业务人员没有意义。 */
const TECHNICAL_FIELDS = new Set([
  'id',
  'tenantId',
  'revision',
  'employeeRevision',
  'createdAt',
  'updatedAt',
  'payloadVersionId',
  'versionId',
  'versionNo',
  'previousVersionId',
]);

const MAX_DEPTH = 2;

/** 前后值逐字段比较；嵌套对象（如 fields / customFields）展开成 a.b 形式，数组整体比较。 */
export function diffAuditFields(before: unknown, after: unknown): AuditFieldChange[] {
  const left = flatten(before);
  const right = flatten(after);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes: AuditFieldChange[] = [];
  for (const key of keys) {
    if (TECHNICAL_FIELDS.has(lastSegment(key))) continue;
    const from = left.get(key) ?? null;
    const to = right.get(key) ?? null;
    if (sameValue(from, to)) continue;
    changes.push({ field: key, from, to });
  }
  return changes;
}

export function renderAuditChanges(changes: readonly AuditFieldChange[]): RenderedAuditChange[] {
  return changes.map((change) => ({
    field: change.field,
    label: auditFieldLabel(lastSegment(change.field).replace(/^custom:/, '')),
    from: change.from,
    to: change.to,
    fromText: change.fromText ?? renderAuditValue(change.from),
    toText: change.toText ?? renderAuditValue(change.to),
  }));
}

export function auditContent(changes: readonly RenderedAuditChange[]): string {
  return changes.map((c) => `${c.label}:从【${c.fromText}】修改为【${c.toText}】`).join('；');
}

const MAX_TEXT = 500;

export function renderAuditValue(value: unknown): string {
  const text = rawText(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function rawText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(rawText).join('、');
  return JSON.stringify(value);
}

function flatten(value: unknown, prefix = '', depth = 0, into = new Map<string, unknown>()): Map<string, unknown> {
  if (isNothing(value)) return into;
  if (!isPlainObject(value)) {
    into.set(prefix || 'value', value);
    return into;
  }
  for (const [key, field] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(field) && depth + 1 < MAX_DEPTH) flatten(field, path, depth + 1, into);
    else into.set(path, field);
  }
  return into;
}

function lastSegment(path: string): string {
  return path.split('.').at(-1) ?? path;
}

function isNothing(value: unknown): boolean {
  return value === null || value === undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => isNothing(v) || v === '';
  if (blank(a) && blank(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
