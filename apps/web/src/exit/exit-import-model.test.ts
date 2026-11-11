// AC-DM-30-F493-FE-02 / 07，文件级检查与读取器回归。
import { describe, expect, it } from 'vitest';
import { EXIT_IMPORT_BODY_LIMIT } from '@italent/domain';
import { importRowsOf } from './exit-import-model.js';
import {
  bombRowsXml,
  buildXlsx,
  importHeader,
  importRows,
  importSheet,
  requiredRows,
  styledBlankRowsXml,
  emptyTextRowsXml,
  xfdRowsXml,
  type Cell,
} from '../../smoke/exit-import-fixtures.js';
import { readXlsx, type Sheet } from './xlsx-reader.js';
const sheetOf = (rows: Cell[][]): Sheet => ({
  date1904: false,
  rows: rows.map((cells, i) => ({ rowNo: i + 1, cells })),
});
const rowsOf = (rows: Cell[][], fileName = '历史离职.xlsx') => importRowsOf(sheetOf(rows), fileName);

describe('AC-DM-30-F493-FE-02 / 07 导入文件解析', () => {
  it('完整 26 列忽略 A，恰好 rowNo 加 25 键，空行跳过，K 文本原样', () => {
    expect(rowsOf(importSheet)).toEqual({ rows: importRows });
    const row = [...importSheet[1]!];
    row[10] = ' 00000000000000000X ';
    expect(rowsOf([importHeader, [], row])).toEqual({ rows: [{ ...importRows[0], rowNo: 3, idNumber: row[10] }] });
    const result = rowsOf(importSheet);
    if ('rows' in result) expect(Object.keys(result.rows[0]!)).toHaveLength(26);
  });

  it('星号容错、列序不限、缺可选列仍补齐 null；不做行级校验', () => {
    expect(
      rowsOf([
        ['最后工作日', '部门编码', '姓名', '电子邮件', '入职日期'],
        ['无效日期', '不存在', null, '格式交后端', '2023/3/15'],
      ]),
    ).toEqual({
      rows: [
        {
          ...importRows[0],
          name: null,
          email: '格式交后端',
          departmentCode: '不存在',
          entryDate: '2023/3/15',
          lastWorkDate: '无效日期',
        },
      ],
    });
    expect(rowsOf(importSheet.map((row) => [...row].reverse()))).toEqual({ rows: importRows });
  });

  it('缺必填、未知列、带星号重复列、空文件整份拒绝', () => {
    const missing = importSheet.map((row) => row.filter((_, i) => i !== 2));
    expect(rowsOf(missing)).toEqual({ error: '缺少必填列：*电子邮件' });
    expect(rowsOf([[...importHeader, '工号'], ...requiredRows(1)])).toEqual({ error: '无法识别的列：工号' });
    expect(rowsOf([[...importHeader, '姓名'], ...requiredRows(1)])).toEqual({ error: '列名重复：*姓名' });
    expect(rowsOf([importHeader])).toEqual({ error: '文件中没有数据行' });
    expect(rowsOf([])).toEqual({ error: '文件中没有数据行' });
  });

  it('1000 行可提交，1001 行整份拒绝', () => {
    const result = rowsOf([importHeader, ...requiredRows(1000)]);
    expect('rows' in result && result.rows.length).toBe(1000);
    expect(rowsOf([importHeader, ...requiredRows(1001)])).toEqual({ error: '一次最多导入 1000 行' });
  });

  it('E I O V 日期序列号按 1900 / 1904 转换，非法数值交后端', async () => {
    for (const date1904 of [false, true]) {
      const row = [...requiredRows(1)[0]!];
      for (const i of [4, 8, 14, 21]) row[i] = date1904 ? 43538 : 45000;
      const result = importRowsOf(await readXlsx(await buildXlsx([importHeader, row], { date1904 })));
      expect(result).toMatchObject({
        rows: [{ entryDate: '2023-03-15', workDate: '2023-03-15', birthday: '2023-03-15', lastWorkDate: '2023-03-15' }],
      });
    }
    for (const [serial, date1904, expected] of [
      [0, true, '1904-01-01'],
      [61, false, '1900-03-01'],
      [60, false, '60'],
      [-1, false, '-1'],
      [45000.5, false, '45000.5'],
    ] as const) {
      const row = [...requiredRows(1)[0]!];
      row[4] = serial;
      expect(importRowsOf({ ...sheetOf([importHeader, row]), date1904 })).toMatchObject({
        rows: [{ entryDate: expected }],
      });
    }
  });

  it('UTF-8 完整报文含 fileName，恰好 1 MiB 可发，超一个字节拒绝', () => {
    const fileName = '含中文与\"引号.xlsx';
    const row = [...requiredRows(1)[0]!];
    row[25] = '';
    const parsed = rowsOf([importHeader, row], fileName);
    if (!('rows' in parsed)) throw new Error(parsed.error);
    const bytes = (rows: unknown) => new TextEncoder().encode(JSON.stringify({ rows, fileName })).length;
    // 空字符串会转 null，换成文本时 JSON 引号比 null 少两字节。
    const room = EXIT_IMPORT_BODY_LIMIT - bytes(parsed.rows) + 2;
    row[25] = '合'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
    const edge = rowsOf([importHeader, row], fileName);
    if (!('rows' in edge)) throw new Error(edge.error);
    expect(bytes(edge.rows)).toBe(EXIT_IMPORT_BODY_LIMIT);
    row[25] += 'x';
    expect(rowsOf([importHeader, row], fileName)).toEqual({ error: '文件过大，请分批导入' });
  });

  it('异常列坐标、压缩炸弹、单元格过多：及时以 XlsxError 中止，不把超长数组或超大文本交给后续解析', async () => {
    const head = importHeader;
    const rejected = async (rowsXml: string, reason: string) => {
      const bytes = await buildXlsx([head, requiredRows(1)[0]!], { rowsXml });
      const started = performance.now();
      await expect(readXlsx(bytes)).rejects.toMatchObject({ name: 'XlsxError', reason });
      expect(performance.now() - started).toBeLessThan(2000);
    };
    // Excel 最大列 XFD（16384）；ZZZZZZ 约 3.2 亿列，直接按下标赋值会造出超长稀疏数组
    await rejected('<row r="3"><c r="ZZZZZZ3"><v>1</v></c></row>', 'format');
    await rejected('<row r="3"><c r="XFE3"><v>1</v></c></row>', 'format');
    expect(
      (await readXlsx(await buildXlsx([head], { rowsXml: '<row r="2"><c r="XFD2"><v>1</v></c></row>' }))).rows[1],
    ).toMatchObject({ rowNo: 2 });
    await rejected(bombRowsXml(), 'limit');
    // 有值的格才计数（只有样式的空白格见下一用例）
    const many = Array.from({ length: 100_001 }, (_, i) => `<c r="A${i + 3}"><v>1</v></c>`).join('');
    await rejected(`<row r="3">${many}</row>`, 'limit');
  });

  it('预先铺好格式的模板：100 行数据 + 尾部 7,200 行 × 26 列带填充样式的空白格，解析后恰好 100 行', async () => {
    // 空白格 7,200 × 26 = 187,200 个：只有样式、没有值，不算有效数据，不能据此整份拒绝
    const bytes = await buildXlsx([importHeader, ...requiredRows(100)], { rowsXml: styledBlankRowsXml(102, 7_200) });
    const parsed = importRowsOf(await readXlsx(bytes));
    expect('rows' in parsed ? parsed.rows.length : parsed.error).toBe(100);
    expect('rows' in parsed && parsed.rows[99]).toMatchObject({ rowNo: 101, email: 'synthetic.100@example.com' });
  });

  it('预先铺好格式的模板：尾部 7,200 行 × 26 列设为空字符串的格式格（空 inlineStr 等）同样按空白格，解析后恰好 100 行', async () => {
    // openpyxl 把空字符串写成 <c r="A102" s="1" t="inlineStr"></c>：回读为空白，不占有值格与展开预算
    for (const mixed of [false, true]) {
      const head = [importHeader, ...requiredRows(100)];
      const sheet = await readXlsx(await buildXlsx(head, { rowsXml: emptyTextRowsXml(102, 7_200, mixed) }));
      expect(sheet.rows).toHaveLength(101);
      const parsed = importRowsOf(sheet);
      expect('rows' in parsed ? parsed.rows.length : parsed.error).toBe(100);
      expect('rows' in parsed && parsed.rows[99]).toMatchObject({ rowNo: 101, email: 'synthetic.100@example.com' });
    }
  });

  it('尾部 10,000 行各一个 XFD 单元格：空白格式格不展开成稠密数组；有值时累计展开超预算受控拒绝', async () => {
    // 100 行有效数据 + 尾部 10,000 行、每行只在 XFD 放一个仅有样式的空白格：文件只有几十 KB
    const started = performance.now();
    const sheet = await readXlsx(
      await buildXlsx([importHeader, ...requiredRows(100)], { rowsXml: xfdRowsXml(102, 10_000) }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
    // 不按最右列坐标逐行展开（否则 10,000 × 16,384 ≈ 1.6 亿个元素）：保留的格数不超过数据本身的格数
    expect(sheet.rows.reduce((n, row) => n + row.cells.length, 0)).toBeLessThanOrEqual(101 * importHeader.length);
    const parsed = importRowsOf(sheet);
    expect('rows' in parsed ? parsed.rows.length : parsed.error).toBe(100);
    // 同样的位置放有值的格：每行确要展开到 XFD，累计超过预算即以 XlsxError 中止，不等全部展开
    const valued = await buildXlsx([importHeader, requiredRows(1)[0]!], {
      rowsXml: xfdRowsXml(3, 10_000, 1),
    });
    const again = performance.now();
    await expect(readXlsx(valued)).rejects.toMatchObject({ name: 'XlsxError', reason: 'limit' });
    expect(performance.now() - again).toBeLessThan(2000);
  });
});
