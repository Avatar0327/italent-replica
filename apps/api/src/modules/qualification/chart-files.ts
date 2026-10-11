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

/** JSON 字面量保留空值与类型；字段路径按级别横向排列，隐藏字段连路径名都不生成。 */
function leaves(value: unknown, prefix = '', result = new Map<string, string>()) {
  if (value === undefined) return result;
  const entries = value !== null && typeof value === 'object' ? Object.entries(value) : [];
  if (!entries.length)
    result.set(
      prefix,
      JSON.stringify(value).replace(/_x[0-9a-f]{4}_/gi, (token) => `\\u005f${token.slice(1)}`),
    );
  else for (const [key, child] of entries) leaves(child, prefix ? `${prefix}/${key}` : key, result);
  return result;
}

export interface ChartFileView {
  readonly standardId?: string;
  readonly levels: readonly object[];
}

export function chartWorkbook(chart: ChartFileView, budget = { rows: 0, bytes: 0 }): Buffer {
  const levels = chart.levels.map((level) => leaves(level));
  const fields = [...new Set(levels.flatMap((level) => [...level.keys()]))];
  const rows = [
    ['字段', '图谱', ...levels.map((_, index) => `级别${index + 1}`)],
    ...(chart.standardId ? [['standardId', JSON.stringify(chart.standardId)]] : []),
    ...(!levels.length ? [['levels', '[]']] : []),
    ...fields.map((field) => [field, '', ...levels.map((level) => level.get(field) ?? '')]),
  ];
  budget.rows += rows.length;
  if (budget.rows > MAX_EXPORT_ROWS) throw exportLimit('EXPORT_ROW_LIMIT', '整批导出最多 10000 行');
  const sheet = rows
    .map((row, index) => {
      const cells = row.map((value) => {
        // JSON 转义控制字符；字符串均为 inlineStr，公式样式文本不会作为公式执行。
        if (value.length > 32767) throw exportLimit('EXPORT_CELL_LIMIT', '导出单元格超过 Excel 的 32767 字符上限');
        const text = `<c t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        budget.bytes += Buffer.byteLength(text);
        boundedSize(budget.bytes);
        return text;
      });
      return `<row r="${index + 1}">${cells.join('')}</row>`;
    })
    .join('');
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
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${NS}"><sheetData>${sheet}</sheetData></worksheet>`,
  };
  return zipFiles(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) })));
}
