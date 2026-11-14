// 矩阵结构的本地草稿、详情解析、PUT structure 请求体与即时校验（设计 §4.2）。契约以后端为准：
// apps/api/src/modules/approval/matrix-input.ts（matrixStructureSchema / validateMatrixStructure）、matrix-structure.ts。
import { MATRIX_DIMENSIONS, MATRIX_LIMITS, VARIABLE_TEXT_FIELDS, textViolation } from '@italent/domain';
import type { FieldError } from '../../foundation/client.js';
import { sameValue } from '../../foundation/forms/values.js';
import { m } from './messages.js';
import { sm } from './structure-messages.js';

export type ColumnKind = 'condition' | 'role';
export type Dimension = (typeof MATRIX_DIMENSIONS)[number];
/** ref 是草稿里的稳定键：已保存的列 / 行用服务端 id，新建的用本地编号；行的 cells 按列 ref 存。 */
export interface DraftColumn {
  ref: string;
  id: string | null;
  kind: ColumnKind;
  dimension: Dimension | null;
  includeChildren: boolean;
  name: string;
  allowMultiple: boolean;
}
export interface DraftRow {
  ref: string;
  id: string | null;
  cells: Record<string, string[]>;
}
export interface Structure {
  columns: DraftColumn[];
  rows: DraftRow[];
}
/** referenceNames（matrix-names.ts）：person → 人员投影或 null，维度 → 名称或 null。 */
export type Names = Record<string, Record<string, unknown>>;
export interface Loaded {
  id: string;
  revision: number;
  structure: Structure;
  names: Names;
}
export interface Issue {
  text: string;
  column?: string;
  row?: string;
}

let local = 0;
export const newRef = () => `n${(local += 1)}`;
const record = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined);
function fail(): never {
  throw new Error(m.invalidResponse);
}
const seqOf = (item: Record<string, unknown>) => (Number.isInteger(item.seq) ? (item.seq as number) : fail());
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((id) => typeof id === 'string') ? (value as string[]) : fail();

function parseColumn(raw: unknown): DraftColumn & { seq: number } {
  const item = record(raw);
  const dimension = item?.dimension ?? null;
  if (
    typeof item?.id !== 'string' ||
    !['condition', 'role'].includes(item.kind as string) ||
    !(dimension === null || MATRIX_DIMENSIONS.includes(dimension as Dimension)) ||
    typeof item.name !== 'string' ||
    typeof item.includeChildren !== 'boolean' ||
    typeof item.allowMultiple !== 'boolean'
  )
    fail();
  const { id, kind, name, includeChildren, allowMultiple } = item as unknown as DraftColumn;
  return {
    ref: id!,
    id,
    kind,
    dimension: dimension as Dimension | null,
    includeChildren,
    name,
    allowMultiple,
    seq: seqOf(item),
  };
}

/** 矩阵详情（头部 + columns + rows + referenceNames）→ 草稿形态：列、行按 seq 排序，单元格补全为全部列。 */
export function parseStructure(raw: unknown): Loaded {
  const body = record(raw);
  if (typeof body?.id !== 'string' || !Number.isInteger(body.revision)) fail();
  if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) fail();
  const bySeq = <T extends { seq: number }>(list: T[]) => list.sort((a, b) => a.seq - b.seq);
  const columns = bySeq(body.columns.map(parseColumn)).map(({ seq: _seq, ...column }) => column);
  const rows = bySeq(
    body.rows.map((raw) => {
      const row = record(raw);
      const cells = record(row?.cells);
      if (typeof row?.id !== 'string' || !cells) fail();
      return {
        ref: row.id,
        id: row.id,
        seq: seqOf(row),
        cells: Object.fromEntries(columns.map((column) => [column.ref, strings(cells[column.id!] ?? [])])),
      };
    }),
  ).map(({ seq: _seq, ...row }) => row);
  const names = (record(body.referenceNames) ?? {}) as Names;
  return { id: body.id, revision: body.revision as number, structure: { columns, rows }, names };
}

/** 比较与提交用的规范形态：列名去首尾空格（后端同样 trim 后保存、按 trim 后判重）。 */
export const normalized = (structure: Structure): Structure => ({
  columns: structure.columns.map((column) => ({ ...column, name: column.name.trim() })),
  rows: structure.rows,
});
export const sameStructure = (a: Structure, b: Structure) => sameValue(normalized(a), normalized(b));
/** 单元格值的名称类别：角色列是人员，条件列是它的维度。 */
export const kindOf = (column: DraftColumn) => (column.kind === 'role' ? 'person' : column.dimension!);

/** PUT structure 请求体：列按数组顺序（后端据此写 seq），短键 c1..cn 按位置分配，每行带全部列的单元格。 */
export function structureBody(structure: Structure, revision?: number) {
  const keys = new Map(structure.columns.map((column, index) => [column.ref, `c${index + 1}`]));
  return {
    revision,
    columns: normalized(structure).columns.map((column) => ({
      ...(column.id ? { id: column.id } : {}),
      key: keys.get(column.ref)!,
      kind: column.kind,
      dimension: column.kind === 'role' ? null : column.dimension,
      includeChildren: column.includeChildren,
      name: column.name,
      allowMultiple: column.allowMultiple,
    })),
    rows: structure.rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      cells: Object.fromEntries(
        structure.columns.map((column) => [keys.get(column.ref)!, row.cells[column.ref] ?? []]),
      ),
    })),
  };
}

export const countKind = (structure: Structure, kind: ColumnKind) =>
  structure.columns.filter((column) => column.kind === kind).length;
export const kindFull = (structure: Structure, kind: ColumnKind) =>
  countKind(structure, kind) >= (kind === 'condition' ? MATRIX_LIMITS.conditionColumns : MATRIX_LIMITS.roleColumns);
export const rowsFull = (structure: Structure) => structure.rows.length >= MATRIX_LIMITS.rows;

/** 列数、行数超上限（409 合并后两边新增可能超出；平时添加按钮到上限即禁用）。 */
function countIssues(structure: Structure): Issue[] {
  const counts = [
    [countKind(structure, 'condition'), MATRIX_LIMITS.conditionColumns, sm.conditionsOver],
    [countKind(structure, 'role'), MATRIX_LIMITS.roleColumns, sm.rolesOver],
    [structure.rows.length, MATRIX_LIMITS.rows, sm.rowsOver],
  ] as const;
  return counts.filter(([count, max]) => count > max).map(([count, max, text]) => ({ text: text(max, count) }));
}

function columnIssues(columns: DraftColumn[]): Issue[] {
  const rule = VARIABLE_TEXT_FIELDS.matrixColumnName;
  const seen = new Set<string>();
  return columns.flatMap((column, index) => {
    const name = column.name.trim();
    const violation = textViolation(name, rule);
    let problem: string | undefined;
    if (!name) problem = sm.nameRequired;
    else if (violation) problem = violation === 'TEXT_TOO_LONG' ? sm.nameTooLong(rule.max) : m.textInvalid;
    else if (seen.has(name)) problem = sm.nameDuplicate;
    seen.add(name);
    return problem ? [{ text: `${sm.column(index)}：${problem}`, column: column.ref }] : [];
  });
}

/** 名称缓存里这个 id 在该类别（person / 维度）下有没有登记的名称。 */
type Known = (kind: string, id: string) => boolean;
const KINDS = ['person', ...MATRIX_DIMENSIONS];

function cellIssue(column: DraftColumn, ids: string[], known: Known) {
  const max = column.kind === 'condition' ? MATRIX_LIMITS.conditionCellIds : MATRIX_LIMITS.roleCellIds;
  if (ids.length > max) return sm.cellLimit(max);
  if (column.kind === 'role' && !column.allowMultiple && new Set(ids).size > 1) return sm.singlePerson;
  // 兜底：后端不核格值类别，部门 / 职位 ID 进了人员格（或反过来）会被原样保存。只认已登记在别的类别下的 ID，
  // 查不到名称的（已失效、尚未回查）不算
  const kind = kindOf(column);
  const misfit = (id: string) => !known(kind, id) && KINDS.some((other) => other !== kind && known(other, id));
  return ids.some(misfit) ? sm.cellMismatch : undefined;
}

/** 与 validateMatrixStructure 同口径的即时校验（同一领域上限，另加格值类别兜底），每条标出列 / 行位置；有问题时不能保存。 */
export function structureIssues(structure: Structure, known: Known): Issue[] {
  const issues = [...countIssues(structure), ...columnIssues(structure.columns)];
  let total = 0;
  structure.rows.forEach((row, index) => {
    for (const column of structure.columns) {
      const ids = row.cells[column.ref] ?? [];
      total += ids.length;
      const problem = cellIssue(column, ids, known);
      if (problem) issues.push({ text: `${sm.cell(index, column.name.trim())}：${problem}`, row: row.ref });
    }
  });
  if (total > MATRIX_LIMITS.totalCellIds) issues.push({ text: sm.totalLimit(MATRIX_LIMITS.totalCellIds, total) });
  return issues;
}

/** 后端 400 的字段明细（zod issue path，按提交时的请求体位置）→ 草稿里的行 / 列位置。 */
export function serverIssues(errors: readonly FieldError[], structure: Structure): Issue[] {
  return errors.map(({ name, errors: messages }) => {
    const [part, index, field, key] = name;
    const message = messages.join('；');
    const at = typeof index === 'number' ? index : -1;
    if (part === 'columns' && structure.columns[at])
      return { text: `${sm.column(at)}：${message}`, column: structure.columns[at].ref };
    const row = part === 'rows' ? structure.rows[at] : undefined;
    if (!row) return { text: message };
    const column =
      field === 'cells' && typeof key === 'string' ? structure.columns[Number(key.slice(1)) - 1] : undefined;
    const where = column ? sm.cell(at, column.name.trim()) : sm.row(at);
    return { text: `${where}：${message}`, row: row.ref };
  });
}

/** 结果未知时原单读回的只读摘要：列名（类型）与行数，不把整份结构的 JSON 摆给用户（冲突核对另见 structure-merge.ts）。 */
export function structureSummary(value: unknown) {
  const structure = value as Structure | undefined;
  if (!structure?.columns) return '—';
  const columns = structure.columns.map((column) => `${column.name.trim()}（${sm.kindLabel[column.kind]}）`);
  return sm.summary(columns.join('、'), structure.rows.length);
}
