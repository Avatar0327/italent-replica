/**
 * 最小 .xlsx 读取（F-139b，历史离职导入）：只取第一个工作表各单元格的值。
 * 不新增依赖：ZIP 中央目录自己读，deflate 用浏览器自带的 DecompressionStream；
 * 不读样式、批注、合并单元格，公式取缓存值；日期单元格是序列号，由调用方按列换算。
 */
export type Cell = string | number | null;
export interface SheetRow {
  /** Excel 实际行号（1 起），空行不出现。 */
  rowNo: number;
  cells: Cell[];
}
export class XlsxError extends Error {}

type Entry = { method: number; size: number; local: number };
const decoder = new TextDecoder();

type Bytes = Uint8Array<ArrayBuffer>;

function directory(bytes: Bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new XlsxError('not a zip');
  const entries = new Map<string, Entry>();
  let at = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new XlsxError('bad directory');
    const nameLength = view.getUint16(at + 28, true);
    entries.set(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)), {
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      local: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return { view, entries };
}

async function inflate(data: Bytes) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(data).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const parts: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value);
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  parts.reduce((offset, part) => (out.set(part, offset), offset + part.length), 0);
  return out;
}

const unescape = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, name: string) => {
    if (name[0] === '#') return String.fromCodePoint(Number(name[1] === 'x' ? `0${name.slice(1)}` : name.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()]!;
  });
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** 富文本拼接各段 <t>；<rPh>（注音）不是单元格内容。 */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => unescape(match[1]!))
    .join('');
const columnOf = (ref: string) =>
  [...(/^[A-Z]+/.exec(ref)?.[0] ?? '')].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;

function cellValue(tag: string, inner: string, shared: string[]): Cell {
  const type = attr(tag, 't');
  if (type === 'inlineStr') return textOf(inner);
  const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (raw === undefined) return null;
  if (type === 's') return shared[Number(raw)] ?? null;
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'e') return unescape(raw);
  return Number(raw);
}

function sheetRows(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: Cell[] = [];
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = columnOf(attr(cell[1]!, 'r') ?? '');
      cells[column < 0 ? cells.length : column] = cellValue(cell[1]!, cell[2] ?? '', shared);
    }
    rows.push({ rowNo: Number(attr(row[1]!, 'r') ?? rows.length + 1), cells: Array.from(cells, (c) => c ?? null) });
  }
  return rows;
}

/** 读第一个工作表（workbook.xml 中排第一的 sheet），按行返回单元格值。 */
export async function readXlsx(bytes: Bytes): Promise<SheetRow[]> {
  const { view, entries } = directory(bytes);
  const read = async (name: string) => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return decoder.decode(data);
    if (entry.method === 8) return decoder.decode(await inflate(data));
    throw new XlsxError('unsupported compression');
  };
  const id = attr(/<sheet\b[^>]*>/.exec((await read('xl/workbook.xml')) ?? '')?.[0] ?? '', 'r:id');
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const relation = [...rels.matchAll(/<Relationship\b[^>]*>/g)].find((tag) => attr(tag[0], 'Id') === id)?.[0];
  const target = relation && attr(relation, 'Target');
  if (!target) throw new XlsxError('no sheet');
  const sheet = await read(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  if (sheet === undefined) throw new XlsxError('no sheet');
  const shared = [...((await read('xl/sharedStrings.xml')) ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)];
  return sheetRows(
    sheet,
    shared.map((match) => textOf(match[1]!)),
  );
}
