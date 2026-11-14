// 流程矩阵头部的路径、解析、回执校验与本地校验。契约以后端为准：
// apps/api/src/modules/approval/matrix-routes.ts、matrices.ts、matrix-input.ts、source-usages.ts。
import { VARIABLE_TEXT_FIELDS, matrixCodeViolation, textViolation } from '@italent/domain';
import { m } from './messages.js';

export const MATRICES = '/api/tenant/approval/matrices';
export const PAGE_SIZE = 50;
export type View = 'active' | 'disabled';
export type MatrixStatus = 'draft' | 'enabled' | 'disabled';
export interface MatrixHead {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: MatrixStatus;
  revision: number;
}
export interface MatrixPage {
  items: MatrixHead[];
  offset: number;
  hasMore: boolean;
}
export interface MatrixReference {
  processCode: string;
  processName: string;
  versionKind: string;
  versionNo: number;
  nodeKey: string;
  nodeName: string;
  position: string;
  /** 被引用的角色列（source-usages.ts columnId）；columnName 由矩阵详情的列定义补上。 */
  columnId: string | null;
  columnName?: string;
  instanceCount: number | null;
}
export interface MatrixReferences {
  items: MatrixReference[];
  total: number;
}

export const matrixPath = (id: string, action?: 'enable' | 'disable' | 'references' | 'structure') =>
  `${MATRICES}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
export function listPath(view: View, q: string, offset: number) {
  const query = new URLSearchParams({ status: view, offset: String(offset), limit: String(PAGE_SIZE) });
  if (q) query.set('q', q);
  return `${MATRICES}?${query}`;
}

const record = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined);
const STATUSES: readonly string[] = ['draft', 'enabled', 'disabled'];
function fail(): never {
  throw new Error(m.invalidResponse);
}
export function parseHead(raw: unknown): MatrixHead {
  const item = record(raw);
  const description = item?.description;
  if (
    typeof item?.id !== 'string' ||
    typeof item.code !== 'string' ||
    typeof item.name !== 'string' ||
    !(description === null || typeof description === 'string') ||
    !STATUSES.includes(item.status as string) ||
    !Number.isInteger(item.revision)
  )
    fail();
  const { id, code, name, status, revision } = item as unknown as MatrixHead;
  return { id, code, name, description: description as string | null, status, revision };
}
export function parseList(raw: unknown): MatrixPage {
  const page = record(raw);
  if (!Array.isArray(page?.items) || !Number.isInteger(page.offset) || typeof page.hasMore !== 'boolean') fail();
  return { items: page.items.map(parseHead), offset: page.offset as number, hasMore: page.hasMore };
}
export function parseReferences(raw: unknown): MatrixReferences {
  const body = record(raw);
  if (!Array.isArray(body?.items) || !Number.isInteger(body.total)) fail();
  const items = body.items.map((raw) => {
    const item = record(raw);
    const columnId = item?.columnId;
    if (typeof item?.processCode !== 'string' || typeof item.nodeKey !== 'string') fail();
    if (!(columnId === null || typeof columnId === 'string')) fail();
    return item as unknown as MatrixReference;
  });
  return { items, total: body.total as number };
}
/** 矩阵详情里的列名（id → 名称），查看引用按 columnId 显示被引用的角色列。 */
export function parseColumnNames(raw: unknown) {
  const columns = record(raw)?.columns;
  if (!Array.isArray(columns)) fail();
  const names = new Map<string, string>();
  for (const column of columns.map(record)) {
    if (typeof column?.id !== 'string' || typeof column.name !== 'string') fail();
    names.set(column.id, column.name);
  }
  return names;
}
/** 写回执：后端返回矩阵详情；id 与原单一致（新建不校验 id），revision 必须是提交时的版本 + 1（新建为 1）。 */
export function parseReceipt(raw: unknown, expected: { id?: string; revision: number }) {
  const body = record(raw);
  const sameId = typeof body?.id === 'string' && (!expected.id || body.id === expected.id);
  if (!sameId || body.revision !== expected.revision + 1 || !STATUSES.includes(body.status as string))
    throw new Error(m.invalidReceipt);
  return { id: body.id as string, status: body.status as MatrixStatus };
}

const textMessage = { TEXT_MALFORMED: m.textInvalid, TEXT_CONTROL_CHAR: m.textInvalid } as const;
/** 名称：去首尾空格后必填、单行、≤100（与 matrix-input.ts 同一领域函数）。 */
export function nameError(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return m.nameRequired;
  const violation = textViolation(name, VARIABLE_TEXT_FIELDS.matrixName);
  if (violation === 'TEXT_TOO_LONG') return m.nameTooLong;
  if (violation === 'TEXT_CONTROL_CHAR' && /[\r\n]/.test(name)) return m.nameSingleLine;
  return violation ? textMessage[violation] : undefined;
}
export function codeError(value: unknown) {
  const code = typeof value === 'string' ? value : '';
  if (!code) return m.codeRequired;
  return matrixCodeViolation(code) ? m.codeInvalid : undefined;
}
/** 描述：可多行、不去空格（后端原样保存），≤255；全空白视为未填，提交 null。 */
export function descriptionError(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const violation = textViolation(value, VARIABLE_TEXT_FIELDS.matrixDescription);
  if (violation === 'TEXT_TOO_LONG') return m.descriptionTooLong;
  return violation ? textMessage[violation] : undefined;
}
export const nameValue = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
export const descriptionValue = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
