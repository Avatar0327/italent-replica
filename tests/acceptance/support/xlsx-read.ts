/**
 * 验收测试用的最小 xlsx 读取器（F-482）：只认 ZIP 的 deflate / stored 条目，解析 workbook 的工作表名与第一张工作表的
 * 单元格（数值 / 内联字符串 / 公式 + 缓存值）、合并区、隐藏的行与列。不依赖任何第三方库，期望值由测试手写，
 * 不拿被测实现的构造函数当参照。
 */
import { inflateRawSync } from 'node:zlib';

export interface XlsxCell {
  /** 'n' 数值，'s' 字符串。 */
  readonly type: 'n' | 's';
  readonly value: number | string;
  /** 公式文本（不含等号）；数据版没有。 */
  readonly formula?: string;
}

export interface Xlsx {
  readonly sheetNames: string[];
  readonly cells: ReadonlyMap<string, XlsxCell>;
  readonly merges: string[];
  readonly hiddenRows: number[];
  readonly hiddenColumns: string[];
  readonly entries: ReadonlyMap<string, string>;
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('不是 ZIP 文件');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed);
    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export function readXlsx(buffer: Buffer): Xlsx {
  const files = unzip(buffer);
  const text = (name: string) => {
    const file = files.get(name);
    if (!file) throw new Error(`缺少 ${name}`);
    return file.toString('utf8');
  };
  const workbook = text('xl/workbook.xml');
  const sheetNames = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unescape(m[1]!));
  const sheet = text('xl/worksheets/sheet1.xml');
  const cells = new Map<string, XlsxCell>();
  for (const match of sheet.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = /r="([A-Z]+\d+)"/.exec(match[1]!)?.[1];
    if (!ref || match[2] === undefined) continue;
    const body = match[2];
    const formula = /<f>([\s\S]*?)<\/f>/.exec(body)?.[1];
    const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
    const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    const formulaOf = formula === undefined ? {} : { formula: unescape(formula) };
    if (inline !== undefined) cells.set(ref, { type: 's', value: unescape(inline), ...formulaOf });
    else if (raw !== undefined && /t="str"/.test(match[1]!))
      cells.set(ref, { type: 's', value: unescape(raw), ...formulaOf });
    else if (raw !== undefined) cells.set(ref, { type: 'n', value: Number(raw), ...formulaOf });
  }
  const merges = [...sheet.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]!);
  const hiddenRows = [...sheet.matchAll(/<row [^>]*r="(\d+)"[^>]*hidden="1"/g)].map((m) => Number(m[1]));
  const hiddenColumns = [...sheet.matchAll(/<col [^>]*hidden="1"[^>]*/g)].map((m) => m[0]);
  return {
    sheetNames,
    cells,
    merges,
    hiddenRows,
    hiddenColumns,
    entries: new Map([...files].map(([name, body]) => [name, body.toString('utf8')])),
  };
}

/** 单元格显示值（数值转原样，空 = undefined）。 */
export const valueAt = (book: Xlsx, ref: string) => book.cells.get(ref)?.value;
/** 一行里从 B 列起的全部值（缺失为 undefined）。 */
export function rowValues(book: Xlsx, row: number, columns: readonly string[]) {
  return columns.map((column) => valueAt(book, `${column}${row}`));
}
/** 全部带公式的单元格。 */
export const formulaCells = (book: Xlsx) => [...book.cells].filter(([, cell]) => cell.formula !== undefined);

/** 列字母 → 序号（A = 1）。 */
const columnIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const columnLetters = (index: number) => {
  let text = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text;
  return text;
};
const numberAt = (book: Xlsx, ref: string) => {
  const cell = book.cells.get(ref);
  return cell && cell.type === 'n' ? (cell.value as number) : undefined;
};
function rangeValues(book: Xlsx, range: string): number[] {
  const [from, to] = range.split(':') as [string, string];
  const [, c1, r1] = /^([A-Z]+)(\d+)$/.exec(from)!;
  const [, c2, r2] = /^([A-Z]+)(\d+)$/.exec(to)!;
  const values: number[] = [];
  for (let column = columnIndex(c1!); column <= columnIndex(c2!); column++)
    for (let row = Number(r1); row <= Number(r2); row++) {
      const value = numberAt(book, `${columnLetters(column)}${row}`);
      if (value !== undefined) values.push(value);
    }
  return values;
}

/**
 * 只认导出会写的三种公式，按单元格里的数值重新算一遍（验证公式引用对了格子，而不只是“有公式”）：
 * SUM(区域)、AVERAGE(区域)、IFERROR(离职/(期初+期末)*2,0)。认不出的公式直接抛错，不静默放过。
 */
export function evaluateFormula(book: Xlsx, formula: string): number {
  const range = /^(SUM|AVERAGE)\(([A-Z]+\d+:[A-Z]+\d+)\)$/.exec(formula);
  if (range) {
    const values = rangeValues(book, range[2]!);
    const total = values.reduce((sum, value) => sum + value, 0);
    return range[1] === 'SUM' ? total : values.length ? total / values.length : 0;
  }
  const rate = /^IFERROR\(([A-Z]+\d+)\/\(([A-Z]+\d+)\+([A-Z]+\d+)\)\*2,0\)$/.exec(formula);
  if (rate) {
    const [exits, opening, closing] = [1, 2, 3].map((i) => numberAt(book, rate[i]!) ?? 0) as [number, number, number];
    const denominator = opening + closing;
    return denominator === 0 ? 0 : (exits * 2) / denominator;
  }
  throw new Error(`不认识的公式：${formula}`);
}
