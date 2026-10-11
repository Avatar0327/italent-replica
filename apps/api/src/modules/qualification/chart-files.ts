/** QL-R12：Excel 横向级别图谱与多选 ZIP。输入只接受已经 presentChart 裁剪的值，不读取原始业务数据。 */
import { deflateRawSync } from 'node:zlib';
import { AppError } from '../../errors.js';

export const MAX_EXPORT_ROWS = 10_000;
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
export const exportLimit = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });

export function boundedSize(size: number) {
  if (size > MAX_EXPORT_BYTES) throw exportLimit('EXPORT_FILE_LIMIT', '导出文件最多 8 MiB，请减少所选类别或标准明细');
}

/** 小型内存 ZIP（Deflate / CRC-32、UTF-8 文件名）；入口已经限制条数与字节，不使用 ZIP64。 */
export function zipFiles(files: readonly { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (const file of files) {
    total += file.data.length;
    boundedSize(total);
    const name = Buffer.from(file.name);
    const data = deflateRawSync(file.data);
    let crc = 0xffffffff;
    for (const byte of file.data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12); // 固定有效日期 1980-01-01，避免引入本机时区
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, directory, end]);
  boundedSize(result.length);
  return result;
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** JSON 已保值编码 C0 与孤立代理项；FFFE / FFFF 也用 JSON 编码，避免依赖读取器的 Excel 转义行为。 */
function literal(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[\uFFFE\uFFFF]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`)
    .replace(/_x[0-9a-f]{4}_/gi, (token) => `\\u005f${token.slice(1)}`);
}

/** 只遍历可见字段；先保留原值引用，等逐格检查字节预算时再序列化，避免预先复制全部长文本。 */
function* leaves(value: unknown, prefix = ''): Generator<readonly [string, unknown]> {
  if (value === undefined) return;
  const entries = value !== null && typeof value === 'object' ? Object.entries(value) : [];
  if (!entries.length) yield [prefix, value];
  else for (const [key, child] of entries) yield* leaves(child, prefix ? `${prefix}/${key}` : key);
}

function* fieldRow(field: string, levels: readonly ReadonlyMap<string, unknown>[]) {
  yield field;
  yield '';
  for (const level of levels) {
    const value = level.get(field);
    yield value === undefined ? '' : literal(value);
  }
}

export interface ChartFileView {
  readonly standardId?: string;
  readonly levels: readonly object[];
}

export function chartWorkbook(chart: ChartFileView, budget = { rows: 0, bytes: 0 }): Buffer {
  const fields = new Set<string>();
  const fixedRows = 1 + (chart.standardId ? 1 : 0) + (chart.levels.length ? 0 : 1);
  const checkRows = () => {
    if (budget.rows + fixedRows + fields.size > MAX_EXPORT_ROWS)
      throw exportLimit('EXPORT_ROW_LIMIT', '整批导出最多 10000 行');
  };
  checkRows();
  const levels = chart.levels.map((level) => {
    const values = new Map<string, unknown>();
    for (const [field, value] of leaves(level)) {
      fields.add(field);
      checkRows();
      values.set(field, value);
    }
    return values;
  });
  budget.rows += fixedRows + fields.size;
  const opening = `<worksheet xmlns="${NS}"><sheetData>`;
  const closing = '</sheetData></worksheet>';
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      </Types>`,
    '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument"
      Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>
      <sheet name="任职资格图谱" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1"
      Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': opening + closing,
  };
  const account = (text: string) => {
    budget.bytes += Buffer.byteLength(text);
    boundedSize(budget.bytes);
    return text;
  };
  // 包括 XML 元数据与行标签；先验行数再逐行生成，不分配“字段行 × 级别列”的完整矩阵。
  for (const part of Object.values(entries)) account(part);
  const rows: string[] = [];
  const writeRow = (values: Iterable<string>) => {
    const cells = [account(`<row r="${rows.length + 1}">`)];
    for (const value of values) {
      if (value.length > 32767) throw exportLimit('EXPORT_CELL_LIMIT', '导出单元格超过 Excel 的 32767 字符上限');
      cells.push(account(`<c t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`));
    }
    cells.push(account('</row>'));
    rows.push(cells.join(''));
  };
  writeRow(['字段', '图谱', ...levels.map((_, index) => `级别${index + 1}`)]);
  if (chart.standardId) writeRow(['standardId', literal(chart.standardId)]);
  if (!levels.length) writeRow(['levels', '[]']);
  for (const field of fields) writeRow(fieldRow(field, levels));
  entries['xl/worksheets/sheet1.xml'] = opening + rows.join('') + closing;
  return zipFiles(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) })));
}
