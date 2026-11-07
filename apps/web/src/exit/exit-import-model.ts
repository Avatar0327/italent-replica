/**
 * 历史离职人员导入（F-139b）的纯规则：Excel 行 → 请求行、preview / import 回执校验、行错误合并。
 * 后端口径：employment/exit-import.ts（parseExitImportBody、previewExitImport、importExits）；
 * 设计 docs/08_设计/F-139_历史离职人员导入_设计.md §2.2、§2.3、§3。资格与逐行校验的权威在服务端。
 */
import { BLACKLIST_REASONS, EXIT_IMPORT_ROW_LIMIT, addDays } from '@italent/domain';
import type { Values } from '../foundation/forms/values.js';
import { x, xi } from './messages.js';
import { exits } from './exit-model.js';
import type { Cell, Sheet } from './xlsx-reader.js';

export const importPath = `${exits}/import`;
export const previewPath = `${importPath}/preview`;

type Text = string | null;
/** 必填列缺值发 null，由服务端逐行报错；可选列未填就不出现（后端 normalizeRow 对缺省与 null 同样处理）。 */
export interface ImportRow {
  rowNo: number;
  employeeNo: Text;
  name: Text;
  entryDate: Text;
  departmentCode: Text;
  lastWorkDate: Text;
  positionCode?: string;
  postCode?: string;
  exitTypeCode?: string;
  exitReasonCode?: string;
  exitDestinationCode?: string;
  addToBlacklist: boolean;
  blacklistReason?: string;
  blacklistExpiryDate?: string;
  blacklistNote?: string;
}
type Field = Exclude<keyof ImportRow, 'rowNo'>;
/**
 * 后端全局请求体上限（apps/api/src/middleware.ts DEFAULT_BODY_LIMIT），按 UTF-8 字节计。
 * 前端先按带 confirmed 的导入报文（两次请求里较大的一份）核对，超限整份拒绝、不发请求，免得 preview / 导入 413。
 */
export const EXIT_IMPORT_BODY_LIMIT = 32 * 1024;
const encoder = new TextEncoder();
const oversized = (rows: ImportRow[]) =>
  encoder.encode(JSON.stringify({ rows, confirmed: true })).length > EXIT_IMPORT_BODY_LIMIT;
const REQUIRED: Field[] = ['employeeNo', 'name', 'entryDate', 'departmentCode', 'lastWorkDate'];
const DATES = new Set<string>(['entryDate', 'lastWorkDate', 'blacklistExpiryDate']);
const reasonCodes = new Map<string, string>(Object.entries(BLACKLIST_REASONS).map(([code, name]) => [name, code]));

/**
 * Excel 日期序列号按工作簿日期系统、按 UTC 字符串换算，不经浏览器时区：
 * 1900 系统 0 = 1899-12-30（60 是虚构的 1900-02-29，61 起才是真实日期）；1904 系统 0 = 1904-01-01。
 * 范围外的值原样交服务端按日期格式拒绝。
 */
function dateOf(serial: number, date1904: boolean) {
  const [epoch, first, last] = date1904 ? ['1904-01-01', 0, 2957003] : ['1899-12-30', 61, 2958465];
  if (!Number.isInteger(serial) || serial < first || serial > last) return String(serial);
  return addDays(epoch, serial);
}
function textOf(field: string, cell: Cell, date1904 = false): Text {
  if (cell === null) return null;
  if (typeof cell === 'number') return DATES.has(field) ? dateOf(cell, date1904) : String(cell);
  return cell.trim() || null;
}
/** 加入黑名单：是 / TRUE → true，否 / FALSE / 空 → false，其他值 undefined（整份拒绝，不猜）。 */
function blacklistOf(value: Text) {
  const upper = value?.toUpperCase();
  if (value === null || value === '否' || upper === 'FALSE') return false;
  if (value === '是' || upper === 'TRUE') return true;
  return undefined;
}

/** 首行列名按 xi.columns 映射（也认 §2.2 的字段名）；未知列、重复列、缺必填列都整份拒绝，不静默丢列。 */
function headerOf(cells: Cell[]): Field[] | string {
  const byLabel = new Map(
    Object.entries(xi.columns).flatMap(([key, label]) => [
      [label, key],
      [key, key],
    ]),
  );
  const fields = cells.map((cell) => byLabel.get(String(cell ?? '').trim()) as Field | undefined);
  const unknown = cells.filter((cell, i) => !fields[i] && String(cell ?? '').trim());
  if (unknown.length) return xi.errors.unknown(unknown.join('、'));
  const repeated = fields.find((field, i) => field && fields.indexOf(field) !== i);
  if (repeated) return xi.errors.duplicate(xi.columns[repeated]!);
  const missing = REQUIRED.filter((field) => !fields.includes(field));
  return missing.length ? xi.errors.missing(missing.map((field) => xi.columns[field]).join('、')) : (fields as Field[]);
}

/** 工作表 → 请求行：rowNo = Excel 行号，空行跳过，空单元格为 null；加黑原因认中文名或编码。 */
export function importRowsOf(sheet: Sheet): { rows: ImportRow[] } | { error: string } {
  const [head, ...body] = sheet.rows.filter((row) => row.cells.some((cell) => textOf('', cell) !== null));
  const fields = head ? headerOf(head.cells) : xi.errors.empty;
  if (typeof fields === 'string') return { error: fields };
  if (!body.length) return { error: xi.errors.empty };
  if (body.length > EXIT_IMPORT_ROW_LIMIT) return { error: xi.errors.tooMany(EXIT_IMPORT_ROW_LIMIT) };
  const rows: ImportRow[] = [];
  for (const { rowNo, cells } of body) {
    const value = (field: Field) => {
      const index = fields.indexOf(field);
      return index < 0 ? null : textOf(field, cells[index] ?? null, sheet.date1904);
    };
    const addToBlacklist = blacklistOf(value('addToBlacklist'));
    if (addToBlacklist === undefined) return { error: xi.errors.blacklist(rowNo) };
    const reason = value('blacklistReason');
    const row = { rowNo } as ImportRow;
    for (const field of Object.keys(xi.columns) as Field[]) {
      const text = value(field);
      if (text !== null || REQUIRED.includes(field)) Object.assign(row, { [field]: text });
    }
    rows.push({ ...row, addToBlacklist, ...(reason && { blacklistReason: reasonCodes.get(reason) ?? reason }) });
  }
  return oversized(rows) ? { error: xi.errors.tooLarge(EXIT_IMPORT_BODY_LIMIT / 1024) } : { rows };
}

export interface ImportIssue {
  field?: string;
  reason: string;
  message: string;
}
export interface ImportWarning {
  from: string;
  to: string;
  peak: number | null;
  limit: number | null;
}
export interface PreviewRow {
  rowNo: number;
  ok: boolean;
  errors: ImportIssue[];
  warnings: ImportWarning[];
}
export interface ImportPreview {
  rows: PreviewRow[];
  hiddenCount: number;
  summary: { total: number; ok: number; failed: number; warned: number };
}

const invalid = () => new Error(x.invalidReceipt);
const isList = (value: unknown): value is Values[] =>
  Array.isArray(value) && value.every((v) => v && typeof v === 'object');
const count = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined);
/** 回执行与提交行一一对应（按 rowNo），对不上就不当作本批的结果。 */
function sameRows(raw: unknown, sent: readonly ImportRow[]): raw is Values[] {
  return isList(raw) && raw.length === sent.length && raw.every((row, i) => row.rowNo === sent[i]!.rowNo);
}

export function parseImportPreview(raw: unknown, sent: readonly ImportRow[]): ImportPreview {
  const body = (raw ?? {}) as Values;
  const summary = (body.summary ?? {}) as Values;
  const hiddenCount = count(body.hiddenCount);
  const counts = ['total', 'ok', 'failed', 'warned'].map((key) => count(summary[key]));
  if (!sameRows(body.rows, sent) || hiddenCount === undefined || counts.includes(undefined)) throw invalid();
  const rows = body.rows.map((row) => {
    if (typeof row.ok !== 'boolean' || !isList(row.errors) || !isList(row.warnings)) throw invalid();
    // 逐条原因 / 警告只用于展示，字段缺失时显示为空，不再逐键校验
    const { errors, warnings } = row as unknown as Pick<PreviewRow, 'errors' | 'warnings'>;
    return { rowNo: Number(row.rowNo), ok: row.ok, errors, warnings };
  });
  const [total, ok, failed, warned] = counts as number[];
  return { rows, hiddenCount, summary: { total: total!, ok: ok!, failed: failed!, warned: warned! } };
}

/** 201 { batchId, rows: [{ rowNo, employeeId, ... }] }：返回导入人数。 */
export function parseImportReceipt(raw: unknown, sent: readonly ImportRow[]): number {
  const body = (raw ?? {}) as Values;
  const valid = sameRows(body.rows, sent) && body.rows.every((row) => typeof row.employeeId === 'string');
  if (typeof body.batchId !== 'string' || !valid) throw invalid();
  return sent.length;
}

/** 导入时整批 400 IMPORT_ROWS_INVALID（预览后数据变了）：把 details.rows 的逐行原因合进预览表。 */
export function withRejectedRows(preview: ImportPreview, error: unknown): ImportPreview | undefined {
  const failure = error as { code?: string; details?: Values } | undefined;
  const rejected = failure?.code === 'IMPORT_ROWS_INVALID' ? failure.details?.rows : undefined;
  if (!isList(rejected)) return undefined;
  const byRow = new Map(rejected.map((row) => [Number(row.rowNo), isList(row.errors) ? row.errors : []]));
  // 有错误行时后端不评估编制：警告一律清空（同 previewExitImport）
  const rows = preview.rows.map((row) => {
    const errors = byRow.get(row.rowNo) as ImportIssue[] | undefined;
    return errors ? { ...row, ok: false, errors, warnings: [] } : { ...row, warnings: [] };
  });
  const failed = rows.filter((row) => !row.ok).length;
  return { rows, hiddenCount: 0, summary: { total: rows.length, ok: rows.length - failed, failed, warned: 0 } };
}

/** 警告的 to 是离职生效日 E（不含），显示为最后一个在职日。 */
export const warningText = (warning: ImportWarning) =>
  xi.warning(warning.from, addDays(warning.to, -1), warning.peak, warning.limit);
