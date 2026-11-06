// F-139b 历史离职人员导入的夹具（组件测试与冒烟共用），数据全部合成。
// 形态对照：preview = exit-import.ts previewExitImport；import 成功 = importExits（201 { batchId, rows }）；
// 未确认的超编 = 409 CONFLICT + details { reason: 'CONFIRMATION_REQUIRED', rows: [{ rowNo, warnings }], hiddenCount }；
// 行错误 = 400 IMPORT_ROWS_INVALID + details.rows；警告 = ImportWarning（ESTABLISHMENT_EXCEEDED）。
export type Cell = string | number | null;

/** 模板列（设计 §2.2 字段，中文名取后端 SHAPE_RULES / NOTE_RULES；原站模板未取证 §13 #U1）。 */
export const importHeader = [
  '工号',
  '姓名',
  '入职日期',
  '部门编码',
  '最后工作日',
  '职位编码',
  '岗位编码',
  '离职类型',
  '离职原因',
  '离职去向',
  '加入黑名单',
  '加黑原因',
  '加黑到期日',
  '加黑说明',
];
/** 第 2 行入职日期是 Excel 日期序列号（45000 = 2023-03-15），第 3 行加黑原因写中文名。 */
export const importSheet: Cell[][] = [
  importHeader,
  ['H0001', '合成甲', 45000, 'D-SYN-01', '2025-06-30', null, null, 'resign', null, null, '否', null, null, null],
  [
    'H0002',
    '合成乙',
    '2023-04-01',
    'D-SYN-01',
    '2025-07-31',
    'P-SYN-01',
    null,
    null,
    null,
    null,
    '是',
    '诚信问题',
    null,
    '合成说明',
  ],
];
const blank = {
  positionCode: null,
  postCode: null,
  exitTypeCode: null,
  exitReasonCode: null,
  exitDestinationCode: null,
  addToBlacklist: false,
  blacklistReason: null,
  blacklistExpiryDate: null,
  blacklistNote: null,
};
/** 上表解析后应发出的行：rowNo = Excel 行号，空单元格为 null。 */
export const importRows = [
  {
    rowNo: 2,
    employeeNo: 'H0001',
    name: '合成甲',
    entryDate: '2023-03-15',
    departmentCode: 'D-SYN-01',
    lastWorkDate: '2025-06-30',
    ...blank,
    exitTypeCode: 'resign',
  },
  {
    rowNo: 3,
    employeeNo: 'H0002',
    name: '合成乙',
    entryDate: '2023-04-01',
    departmentCode: 'D-SYN-01',
    lastWorkDate: '2025-07-31',
    ...blank,
    positionCode: 'P-SYN-01',
    addToBlacklist: true,
    blacklistReason: 'integrity',
    blacklistNote: '合成说明',
  },
];
export const importDepartment = '61000000-0000-4000-8000-000000000001';
export const warning = {
  reason: 'ESTABLISHMENT_EXCEEDED',
  capacityId: '64000000-0000-4000-8000-000000000001',
  departmentId: importDepartment,
  positionId: null,
  from: '2023-04-01',
  to: '2025-08-01',
  peak: 6,
  limit: 5,
};
type Row = { rowNo: number };
export const previewWarned = (rows: Row[]) => ({
  rows: rows.map((row, index) => ({ rowNo: row.rowNo, ok: true, errors: [], warnings: index === 1 ? [warning] : [] })),
  hiddenCount: 0,
  summary: { total: rows.length, ok: rows.length, failed: 0, warned: rows.length > 1 ? 1 : 0 },
});
export const duplicateError = {
  field: 'employeeNo',
  reason: 'EMPLOYEE_NO_EXISTS',
  message: '工号已存在',
};
/** 有错误行时后端不评估编制：所有行 warnings 为空、hiddenCount 为 0。 */
export const previewFailed = (rows: Row[]) => ({
  rows: rows.map((row, index) => ({
    rowNo: row.rowNo,
    ok: index !== 0,
    errors: index === 0 ? [duplicateError] : [],
    warnings: [],
  })),
  hiddenCount: 0,
  summary: { total: rows.length, ok: rows.length - 1, failed: 1, warned: 0 },
});
export const confirmationRequired = (rows: Row[]) => ({
  error: {
    code: 'CONFLICT',
    message: '导入后将超出设定编制，请确认',
    details: {
      reason: 'CONFIRMATION_REQUIRED',
      rows: [{ rowNo: rows[1]!.rowNo, warnings: [warning] }],
      hiddenCount: 0,
    },
  },
});
const pad = (n: number) => String(n).padStart(12, '0');
export const importReceipt = (rows: Row[]) => ({
  batchId: '65000000-0000-4000-8000-000000000001',
  rows: rows.map((row, i) => ({
    rowNo: row.rowNo,
    employeeId: `31000000-0000-4000-8000-${pad(100 + i)}`,
    hireBusinessId: `66000000-0000-4000-8000-${pad(100 + i)}`,
    exitBusinessId: `71000000-0000-4000-8000-${pad(100 + i)}`,
  })),
});

// ---- 最小 xlsx 生成（只供测试造文件：共享字符串 + 数字单元格，deflate 压缩，与 Excel 产物同构） ----
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const column = (index: number) => String.fromCharCode(65 + index);
function sheetFiles(sheet: Cell[][], date1904: boolean) {
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
    'xl/sharedStrings.xml':
      `<?xml version="1.0" encoding="UTF-8"?><sst ${ns}>` +
      strings.map((s) => `<si><t>${escape(s)}</t></si>`).join('') +
      '</sst>',
    'xl/worksheets/sheet1.xml':
      `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}>` + `<sheetData>${rows.join('')}</sheetData></worksheet>`,
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
/** 生成 .xlsx 字节（ZIP：本地头 + 中央目录 + 目录尾）；date1904 = 工作簿用 1904 日期系统（Mac 版 Excel 可选）。 */
export async function buildXlsx(
  sheet: Cell[][],
  options: { date1904?: boolean } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(sheetFiles(sheet, options.date1904 === true))) {
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
