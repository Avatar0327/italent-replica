/**
 * 统计报表导出用的最小 xlsx 写入器（F-482）：单个工作表「Sheet1」、数值 / 内联字符串 / 公式（带缓存值）与合并区。
 * 版式按原站取证（evidence §4）：A 列空、不冻结窗格、没有定义名称与超链接，也不隐藏任何行列。
 * 复用 qualification 的内存 ZIP（Deflate / CRC-32）与 8 MiB 上限，不引入第三方库。
 */
import { boundedSize, zipFiles } from '../qualification/chart-files.js';

/** 数值、字符串，或带缓存值的公式（公式文本不含等号）。 */
export type StatCell = number | string | { readonly value: number; readonly formula: string };
export type ExportMode = 'data' | 'formula';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// XML 1.0 不允许的控制字符与非字符码位不写进文件（按码位过滤，免得正则里写控制字符）
const allowed = (code: number) =>
  code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0xfffe && code !== 0xffff);
const clean = (value: string) => [...value].filter((ch) => allowed(ch.codePointAt(0)!)).join('');

/** 列号 → 字母（1 = A）。 */
export function columnLetters(index: number): string {
  let text = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text;
  return text;
}
const columnIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** 一个工作表：按“列字母 + 行号”写格，合并区单独登记。 */
export class StatSheet {
  readonly #cells = new Map<string, StatCell>();
  readonly #merges: string[] = [];

  set(ref: string, cell: StatCell | null | undefined): void {
    if (cell !== null && cell !== undefined) this.#cells.set(ref, cell);
  }
  merge(range: string): void {
    this.#merges.push(range);
  }

  #cellXml(ref: string, cell: StatCell): string {
    if (typeof cell === 'string')
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(clean(cell))}</t></is></c>`;
    if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
    return `<c r="${ref}"><f>${escape(cell.formula)}</f><v>${cell.value}</v></c>`;
  }

  xml(): string {
    const rows = new Map<number, [number, string][]>();
    for (const [ref, cell] of this.#cells) {
      const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(ref)!;
      const line = rows.get(Number(row)) ?? [];
      line.push([columnIndex(letters!), this.#cellXml(ref, cell)]);
      rows.set(Number(row), line);
    }
    const data = [...rows]
      .sort(([a], [b]) => a - b)
      .map(
        ([row, line]) =>
          `<row r="${row}">${line
            .sort(([a], [b]) => a - b)
            .map(([, xml]) => xml)
            .join('')}</row>`,
      )
      .join('');
    const mergeXml = this.#merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('');
    const merges = mergeXml ? `<mergeCells count="${this.#merges.length}">${mergeXml}</mergeCells>` : '';
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return `${head}<worksheet xmlns="${NS}"><sheetData>${data}</sheetData>${merges}</worksheet>`;
  }
}

/** 单工作表（Sheet1）的 xlsx 文件。 */
export function statWorkbook(sheet: StatSheet): Buffer {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const entries: Record<string, string> = {
    '[Content_Types].xml': `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `${head}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument"
      Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${head}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>
      <sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="${PKG}"><Relationship Id="rId1"
      Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet.xml(),
  };
  const files = Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) }));
  boundedSize(files.reduce((sum, file) => sum + file.data.length, 0));
  return zipFiles(files);
}

/** 下载响应头：ASCII 兜底名 + UTF-8 文件名（RFC 5987），中文报表名不会乱码。 */
export function attachmentHeader(fileName: string): string {
  return `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
