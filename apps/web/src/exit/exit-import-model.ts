/** F-493 §3.1 / §9.1：只做文件级检查，逐行业务校验交服务端。 */
import {
  EXIT_IMPORT_COLUMNS,
  EXIT_IMPORT_BODY_LIMIT,
  EXIT_IMPORT_ROW_LIMIT,
  addDays,
  type ExitImportRowKey,
} from '@italent/domain';
import { x, xi } from './messages.js';
import { exits } from './exit-model.js';
import type { Cell, Sheet } from './xlsx-reader.js';

export const importPath = `${exits}/import`;
export type ImportRow = { rowNo: number } & Record<ExitImportRowKey, string | null>;
const DATES = new Set<string>(['entryDate', 'workDate', 'birthday', 'lastWorkDate']);
const dataColumns = EXIT_IMPORT_COLUMNS.filter((column) => column.key !== null);
const normalize = (label: string) => label.trim().replace(/^\*/, '');

/** 1900 系统的虚构闰日与范围外序列号原样交后端；1904 系统照工作簿标识转换。 */
function dateOf(serial: number, date1904: boolean) {
  const [epoch, first, last] = date1904 ? ['1904-01-01', 0, 2957003] : ['1899-12-30', 61, 2958465];
  if (!Number.isInteger(serial) || serial < first || serial > last) return String(serial);
  return addDays(epoch, serial);
}
function textOf(field: string, cell: Cell, date1904 = false): string | null {
  if (cell === null || (typeof cell === 'string' && !cell.trim())) return null;
  if (typeof cell === 'number') return DATES.has(field) ? dateOf(cell, date1904) : String(cell);
  return cell;
}
function headerOf(cells: Cell[]) {
  const columns = cells.map((cell) =>
    EXIT_IMPORT_COLUMNS.find((column) => normalize(column.name) === normalize(String(cell ?? ''))),
  );
  const unknown = cells.filter((cell, i) => !columns[i] && String(cell ?? '').trim());
  if (unknown.length) return xi.errors.unknown(unknown.join('、'));
  const repeated = columns.find((column, i) => column && columns.indexOf(column) !== i);
  if (repeated) return xi.errors.duplicate(repeated.name);
  const missing = EXIT_IMPORT_COLUMNS.filter((column) => column.required && !columns.includes(column));
  return missing.length ? xi.errors.missing(missing.map((column) => column.name).join('、')) : columns;
}

/** 请求体按实际 JSON 的 UTF-8 字节计，包含上传文件名。 */
export function importRowsOf(sheet: Sheet, fileName = ''): { rows: ImportRow[] } | { error: string } {
  const [head, ...body] = sheet.rows.filter((row) => row.cells.some((cell) => textOf('', cell) !== null));
  const columns = head ? headerOf(head.cells) : xi.errors.empty;
  if (typeof columns === 'string') return { error: columns };
  // A 列整列忽略，只有旧错误原文的数据行也不构成一条新人员输入。
  const data = body.filter(({ cells }) =>
    columns.some((column, i) => column?.key && textOf('', cells[i] ?? null) !== null),
  );
  if (!data.length) return { error: xi.errors.empty };
  if (data.length > EXIT_IMPORT_ROW_LIMIT) return { error: xi.errors.tooMany(EXIT_IMPORT_ROW_LIMIT) };
  const rows = data.map(({ rowNo, cells }) => {
    const row = { rowNo } as ImportRow;
    for (const column of dataColumns) {
      const index = columns.indexOf(column);
      row[column.key!] = textOf(column.key!, cells[index] ?? null, sheet.date1904);
    }
    return row;
  });
  return new TextEncoder().encode(JSON.stringify({ rows, fileName })).length > EXIT_IMPORT_BODY_LIMIT
    ? { error: xi.errors.tooLarge }
    : { rows };
}

/** 当前后端提交回执固定为 queued，total 对应原命令行数。 */
export function parseImportReceipt(raw: unknown, sent: readonly ImportRow[]): void {
  const body = raw as { batchId?: unknown; status?: unknown; total?: unknown } | null;
  if (typeof body?.batchId !== 'string' || !body.batchId || body.status !== 'queued' || body.total !== sent.length)
    throw new Error(x.invalidReceipt);
}
