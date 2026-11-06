/**
 * 最小 .xlsx 读取（F-139b，历史离职导入）：只取第一个工作表各单元格的值。
 * 不新增依赖：ZIP 中央目录自己读，deflate 用浏览器自带的 DecompressionStream；
 * 不读样式、批注、合并单元格，公式取缓存值；日期单元格是序列号，由调用方按列和工作簿日期系统换算。
 */
export type Cell = string | number | null;
export interface SheetRow {
  /** Excel 实际行号（1 起），空行不出现。 */
  rowNo: number;
  cells: Cell[];
}
export interface Sheet {
  rows: SheetRow[];
  /** 工作簿用 1904 日期系统（workbookPr date1904）：序列号 0 = 1904-01-01，否则 1900 系统。 */
  date1904: boolean;
}
/**
 * reason：format = 不是合法的 xlsx（坐标越界等）；limit = 解压后过大或有值单元格过多。
 * 100 行导入远用不到下面两个上限，超过即中止，防压缩炸弹与异常文件卡死页面。
 */
export class XlsxError extends Error {
  override name = 'XlsxError';
  constructor(
    message: string,
    readonly reason: 'format' | 'limit' = 'format',
  ) {
    super(message);
  }
}
/** 单个部件（工作表、共享字符串等）解压后的字节上限。 */
export const XLSX_PART_LIMIT = 16 * 1024 * 1024;
/**
 * 有值单元格的总数上限；每行展开成稠密数组后的累计格数也以它为上限。
 * 只有样式的空白格不计（铺好格式的模板尾部常有上万个），它们的扫描量由 XLSX_PART_LIMIT 兜住。
 */
export const XLSX_CELL_LIMIT = 100_000;
/** Excel 最大列 XFD = 16384：列坐标超出即判文件非法，不按下标造超长稀疏数组。 */
const COLUMN_LIMIT = 16384;
/** 每次喂给解压流的压缩字节：deflate 最大约 1032 倍，超限时最多多解开一片。 */
const FEED = 16 * 1024;

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

/** 分片喂入、边读边计数：解压输出超过 XLSX_PART_LIMIT 立即取消，不等整份解开（压缩炸弹）。 */
async function inflate(data: Bytes) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // 写入受读端背压节流；读端取消后写入被拒，喂入随之停止。
  void (async () => {
    for (let at = 0; at < data.length; at += FEED) await writer.write(data.subarray(at, at + FEED));
    await writer.close();
  })().catch(() => undefined);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.length;
    if (total > XLSX_PART_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw new XlsxError('part too large', 'limit');
    }
    parts.push(next.value);
  }
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
/** 没有 r 的单元格接在上一格后面（-1）；有 r 就必须是 A1 形式且列不超过 XFD，否则整份拒绝。 */
const columnOf = (ref: string | undefined) => {
  if (ref === undefined) return -1;
  const letters = /^([A-Z]{1,3})\d+$/.exec(ref)?.[1];
  const column = letters ? [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1 : -1;
  if (column < 0 || column >= COLUMN_LIMIT) throw new XlsxError('bad cell reference');
  return column;
};

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

/**
 * 每行只按列号稀疏记下有值的格；空白、仅有样式的格不占位（否则一个 XFD 空白格就让一行展开成 16,384 个元素）。
 * 有值的行展开成到最右有值列为止的稠密数组，展开前核对累计格数，超过 XLSX_CELL_LIMIT 即中止。
 */
function sheetRows(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  let count = 0;
  let expanded = 0;
  let physical = 0;
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    physical++;
    const values = new Map<number, Cell>();
    let next = 0;
    let width = 0;
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = columnOf(attr(cell[1]!, 'r'));
      const at = column < 0 ? next : column;
      next = at + 1;
      const value = cellValue(cell[1]!, cell[2] ?? '', shared);
      if (value === null) continue;
      if (++count > XLSX_CELL_LIMIT) throw new XlsxError('too many cells', 'limit');
      values.set(at, value);
      width = Math.max(width, next);
    }
    if (!width) continue;
    if ((expanded += width) > XLSX_CELL_LIMIT) throw new XlsxError('too many cells', 'limit');
    const cells = Array.from({ length: width }, (_, i) => values.get(i) ?? null);
    rows.push({ rowNo: Number(attr(row[1]!, 'r') ?? physical), cells });
  }
  return rows;
}

/** 读第一个工作表（workbook.xml 中排第一的 sheet），按行返回单元格值与工作簿的日期系统。 */
export async function readXlsx(bytes: Bytes): Promise<Sheet> {
  const { view, entries } = directory(bytes);
  const read = async (name: string) => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0 && data.length > XLSX_PART_LIMIT) throw new XlsxError('part too large', 'limit');
    if (entry.method === 0) return decoder.decode(data);
    if (entry.method === 8) return decoder.decode(await inflate(data));
    throw new XlsxError('unsupported compression');
  };
  const workbook = (await read('xl/workbook.xml')) ?? '';
  const id = attr(/<sheet\b[^>]*>/.exec(workbook)?.[0] ?? '', 'r:id');
  const date1904 = ['1', 'true'].includes(attr(/<workbookPr\b[^>]*>/.exec(workbook)?.[0] ?? '', 'date1904') ?? '');
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? '';
  const relation = [...rels.matchAll(/<Relationship\b[^>]*>/g)].find((tag) => attr(tag[0], 'Id') === id)?.[0];
  const target = relation && attr(relation, 'Target');
  if (!target) throw new XlsxError('no sheet');
  const sheet = await read(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  if (sheet === undefined) throw new XlsxError('no sheet');
  const shared = [...((await read('xl/sharedStrings.xml')) ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)];
  return {
    rows: sheetRows(
      sheet,
      shared.map((match) => textOf(match[1]!)),
    ),
    date1904,
  };
}
