// F-493 S4a 合成夹具。202 回执对照 submitExitImport，列名独立抄录设计 §3.1。
export type Cell = string | number | null;
export const importHeader = [
  '导入结果',
  '*姓名',
  '*电子邮件',
  '*部门编码',
  '*入职日期',
  '职位名称',
  '职务名称',
  '职级',
  '参加工作日期',
  '工作地点',
  '身份证号',
  '手机号码',
  '个人邮箱',
  '性别',
  '出生日期',
  '民族',
  '政治面貌',
  '户籍所在地',
  '籍贯',
  '毕业学校',
  '专业',
  '*最后工作日',
  '离职类型',
  '离职原因',
  '离职后去向',
  '离职说明',
];
const blank = {
  positionName: null,
  postName: null,
  levelName: null,
  workDate: null,
  place: null,
  idNumber: null,
  mobilePhone: null,
  personalEmail: null,
  gender: null,
  birthday: null,
  nation: null,
  politicalStatus: null,
  householdAddress: null,
  registAddress: null,
  school: null,
  major: null,
  exitTypeName: null,
  exitReasonName: null,
  whereaboutsName: null,
  exitNote: null,
};
export const importRows = ['合成甲', '合成乙', '合成丙'].map((name, i) => ({
  rowNo: i + 2,
  name,
  email: `synthetic.${i + 1}@example.com`,
  departmentCode: 'D-SYN-01',
  entryDate: '2023-03-15',
  lastWorkDate: '2025-06-30',
  ...blank,
}));
export const importSheet: Cell[][] = [
  importHeader,
  ...importRows.map((row) => [
    '旧错误原文应忽略',
    row.name,
    row.email,
    row.departmentCode,
    45000,
    ...Array<Cell>(16).fill(null),
    row.lastWorkDate,
    ...Array<Cell>(4).fill(null),
  ]),
];
export const importReceipt = (rows: { rowNo: number }[]) => ({
  batchId: '65000000-0000-4000-8000-000000000001',
  status: 'queued',
  total: rows.length,
});
/** 压缩炸弹：单元格解压后 64 MiB。 */
export const bombRowsXml = () =>
  `<row r="9"><c r="A9" t="inlineStr"><is><t>${'A'.repeat(64 * 1024 * 1024)}</t></is></c></row>`;

// ---- 最小 xlsx 生成（只供测试造文件：共享字符串 + 数字单元格，deflate 压缩，与 Excel 产物同构） ----
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const column = (index: number): string =>
  index < 26 ? String.fromCharCode(65 + index) : column(Math.floor(index / 26) - 1) + column(index % 26);
/** count 行只填必填列，位置对应完整 26 列模板。 */
export const requiredRows = (count: number): Cell[][] =>
  Array.from({ length: count }, (_, i) => [
    null,
    `合成${i + 1}`,
    `synthetic.${i + 1}@example.com`,
    'D-SYN-01',
    '2023-03-15',
    ...Array<Cell>(16).fill(null),
    '2025-06-30',
    ...Array<Cell>(4).fill(null),
  ]);
/** 预先铺好格式的空白行：每格只有样式 s="1"（styles.xml 里的填充色），没有值，与 Excel 刷过格式的模板同构。 */
export const styledBlankRowsXml = (from: number, count: number, columns = importHeader.length) =>
  Array.from({ length: count }, (_, i) => {
    const cells = Array.from({ length: columns }, (_, c) => `<c r="${column(c)}${from + i}" s="1"/>`);
    return `<row r="${from + i}">${cells.join('')}</row>`;
  }).join('');
/** 设为空字符串的格式格：openpyxl 写成无文本的 inlineStr；mixed 时按列轮换其他同样回读为空的写法。 */
const emptyTextCells = [
  (ref: string) => `<c r="${ref}" s="1" t="inlineStr"></c>`,
  (ref: string) => `<c r="${ref}" s="1" t="inlineStr"><is><t></t></is></c>`,
  (ref: string) => `<c r="${ref}" s="1" t="str"><v></v></c>`,
];
export const emptyTextRowsXml = (from: number, count: number, mixed = false) =>
  Array.from({ length: count }, (_, i) => {
    const cells = importHeader.map((_, c) =>
      emptyTextCells[mixed ? c % emptyTextCells.length : 0]!(`${column(c)}${from + i}`),
    );
    return `<row r="${from + i}">${cells.join('')}</row>`;
  }).join('');
/** 每行只在最右列 XFD 放一个单元格：不给 value 是只有样式的空白格，给了是有值的格。 */
export const xfdRowsXml = (from: number, count: number, value?: number) =>
  Array.from({ length: count }, (_, i) => {
    const ref = `XFD${from + i}`;
    const cell = value === undefined ? `<c r="${ref}" s="1"/>` : `<c r="${ref}"><v>${value}</v></c>`;
    return `<row r="${from + i}">${cell}</row>`;
  }).join('');
function sheetFiles(sheet: Cell[][], date1904: boolean, rowsXml = '') {
  const strings: string[] = [];
  const rows = sheet.map((cells, r) => {
    const xml = cells.map((cell, c) => {
      const ref = `${column(c)}${r + 1}`;
      if (cell === null) return '';
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      strings.push(cell);
      return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
    });
    return `<row r="${r + 1}">${xml.join('')}</row>`;
  });
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return {
    'xl/workbook.xml':
      `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="${rel}">` +
      (date1904 ? '<workbookPr date1904="1"/>' : '') +
      '<sheets><sheet name="离职人员" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    // 第 2 号 xf 带实心填充：空白格靠 s="1" 引用它（读取器不读样式，只为与 Excel 产物同构）
    'xl/styles.xml':
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${ns}><fills count="3">` +
      '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill></fills>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
      '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" applyFill="1"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml':
      `<?xml version="1.0" encoding="UTF-8"?><sst ${ns}>` +
      strings.map((s) => `<si><t>${escape(s)}</t></si>`).join('') +
      '</sst>',
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}>` +
      `<sheetData>${rows.join('')}${rowsXml}</sheetData></worksheet>`,
  };
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
async function deflate(bytes: Uint8Array<ArrayBuffer>) {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const parts: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value);
  return concat(parts);
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) out.set(part, (offset += part.length) - part.length);
  return out;
}
function header(size: number, fields: [number, number][]) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const [width, value] of fields) {
    if (width === 4) view.setUint32(at, value, true);
    else view.setUint16(at, value, true);
    at += width;
  }
  return bytes;
}
/**
 * 生成 .xlsx 字节（ZIP：本地头 + 中央目录 + 目录尾）；date1904 = 工作簿用 1904 日期系统（Mac 版 Excel 可选）。
 * rowsXml 原样追加到 sheetData 末尾，用来造异常坐标、超大或超多单元格的文件。
 */
export async function buildXlsx(
  sheet: Cell[][],
  options: { date1904?: boolean; rowsXml?: string } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(sheetFiles(sheet, options.date1904 === true, options.rowsXml))) {
    const raw = new TextEncoder().encode(text);
    const data = await deflate(raw);
    const path = new TextEncoder().encode(name);
    const common: [number, number][] = [
      [2, 20],
      [2, 0x0800],
      [2, 8],
      [2, 0],
      [2, 0],
      [4, crc32(raw)],
      [4, data.length],
      [4, raw.length],
      [2, path.length],
      [2, 0],
    ];
    local.push(header(30, [[4, 0x04034b50], ...common]), path, data);
    central.push(header(46, [[4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), path);
    offset += 30 + path.length + data.length;
  }
  const directory = concat(central);
  const count = central.length / 2;
  const end = header(22, [
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, count],
    [2, count],
    [4, directory.length],
    [4, offset],
    [2, 0],
  ]);
  return concat([...local, directory, end]);
}
