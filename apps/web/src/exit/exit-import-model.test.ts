// AC-DM-30-19（对应设计 AC-DM-30-13）：Excel → 请求行的文件级拒绝；逐行校验的权威在服务端，前端不重复。
import { describe, expect, it } from 'vitest';
import { importRowsOf, warningText } from './exit-import-model.js';
import {
  bombRowsXml,
  buildXlsx,
  importHeader,
  importRows,
  importSheet,
  requiredRows,
  styledBlankRowsXml,
  emptyTextRowsXml,
  warning,
  xfdRowsXml,
  type Cell,
} from '../../smoke/exit-import-fixtures.js';
import { readXlsx } from './xlsx-reader.js';

const rowsOf = async (sheet: Cell[][]) => importRowsOf(await readXlsx(await buildXlsx(sheet)));
const H0003 = ['H0003', '合成丙', '2024-01-02', 'D-SYN-01', '2025-01-31'];

describe('AC-DM-30-19 导入文件解析', () => {
  it('列顺序不限、空行跳过，rowNo 仍是 Excel 行号', async () => {
    const sheet = [['姓名', '工号', '入职日期', '部门编码', '最后工作日'], [], ['合成丙', 'H0003', ...H0003.slice(2)]];
    const parsed = await rowsOf(sheet);
    expect(parsed).toMatchObject({ rows: [{ rowNo: 3, employeeNo: 'H0003', name: '合成丙', addToBlacklist: false }] });
    expect(await rowsOf(importSheet)).toEqual({ rows: importRows });
  });

  it('缺必填列、未知列、重复列、空文件、超过 1000 行、加入黑名单非法值都整份拒绝', async () => {
    const head = importHeader.slice(0, 5);
    expect(await rowsOf([head.slice(1), H0003.slice(1)])).toEqual({ error: '缺少必填列：工号' });
    expect(
      await rowsOf([
        [...head, '备注'],
        [...H0003, 'x'],
      ]),
    ).toEqual({ error: '无法识别的列：备注' });
    expect(
      await rowsOf([
        [...head, '工号'],
        [...H0003, 'H0004'],
      ]),
    ).toEqual({ error: '列名重复：工号' });
    expect(await rowsOf([head])).toEqual({ error: '文件中没有数据行' });
    // 行数上限与后端同为 1000（设计 §5、§9.1：domain 常量前后端共用）：1001 行整份拒绝；恰 1000 行不报行数错
    // （前端的 32KB 体积预判是第 1 版遗留，S4a 改为 1 MiB 前 1000 行仍会先报体积错，故只断言不是行数错）
    const many = (n: number) => rowsOf([head, ...Array.from({ length: n }, () => H0003)]);
    expect(await many(1001)).toEqual({ error: '一次最多导入 1000 行' });
    expect(await many(1000)).not.toEqual({ error: '一次最多导入 1000 行' });
    expect(
      await rowsOf([
        [...head, '加入黑名单'],
        [...H0003, '可能'],
      ]),
    ).toEqual({
      error: '第 2 行“加入黑名单”只能填写“是”或“否”',
    });
  });

  it('日期序列号按工作簿日期系统换算：同一日期在 1900 / 1904 系统下得到相同请求报文', async () => {
    // 1904 系统（workbookPr date1904）的序列号比 1900 系统小 1462 天；文本日期不受影响
    const in1904 = importSheet.map((cells, r) =>
      r ? cells.map((c) => (typeof c === 'number' ? c - 1462 : c)) : cells,
    );
    const read1904 = importRowsOf(await readXlsx(await buildXlsx(in1904, { date1904: true })));
    expect(read1904).toEqual(await rowsOf(importSheet));
    expect(read1904).toEqual({ rows: importRows });
    // 1904 系统 0 = 1904-01-01；按 UTC 字符串换算，不经浏览器时区
    const one = (serial: number, date1904?: boolean) =>
      buildXlsx([importHeader.slice(0, 5), ['H0003', '合成丙', serial, 'D-SYN-01', '2025-01-31']], { date1904 });
    const entryOf = async (serial: number, date1904?: boolean) => {
      const parsed = importRowsOf(await readXlsx(await one(serial, date1904)));
      return 'rows' in parsed ? parsed.rows[0]!.entryDate : parsed.error;
    };
    expect(await entryOf(0, true)).toBe('1904-01-01');
    expect(await entryOf(43538, true)).toBe('2023-03-15');
    // 1900 系统闰年边界：60 是 Excel 虚构的 1900-02-29，原样交服务端拒绝；61 = 1900-03-01
    expect(await entryOf(61)).toBe('1900-03-01');
    expect(await entryOf(60)).toBe('60');
    expect(await entryOf(45000)).toBe('2023-03-15');
  });

  it('请求体按 UTF-8 字节计：100 行仅填必填列不超 32KB；恰到上限可发，超 1 字节整份拒绝', async () => {
    // 后端 apps/api/src/middleware.ts DEFAULT_BODY_LIMIT = 32 * 1024；带 confirmed 的导入报文是两次请求里较大的一份
    const LIMIT = 32 * 1024;
    const bytes = (rows: unknown) => new TextEncoder().encode(JSON.stringify({ rows, confirmed: true })).length;
    const required = (i: number) => [
      `H${String(i).padStart(4, '0')}`,
      `合成${i}`,
      '2023-03-15',
      'D-SYN-01',
      '2025-06-30',
    ];
    const template = (note = '') =>
      Array.from({ length: 100 }, (_, i) => [...required(i + 1), ...Array<Cell>(8).fill(null), i === 99 ? note : null]);
    const parsed = await rowsOf([importHeader, ...template()]);
    if (!('rows' in parsed)) throw new Error(parsed.error);
    expect(parsed.rows).toHaveLength(100);
    expect(parsed.rows[0]).toEqual({
      rowNo: 2,
      employeeNo: 'H0001',
      name: '合成1',
      entryDate: '2023-03-15',
      departmentCode: 'D-SYN-01',
      lastWorkDate: '2025-06-30',
      addToBlacklist: false,
    });
    expect(bytes(parsed.rows)).toBeLessThanOrEqual(LIMIT);
    // 末行加黑说明补到恰好上限：键 ,"blacklistNote":"" 占 19 字节，正文中文按 3 字节计（字符数远小于上限）
    const room = LIMIT - bytes(parsed.rows) - 19;
    const note = '合'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
    const edge = await rowsOf([importHeader, ...template(note)]);
    if (!('rows' in edge)) throw new Error(edge.error);
    expect(bytes(edge.rows)).toBe(LIMIT);
    const tooLarge = '文件内容超过单次导入上限（32 KB），请减少行数或缩短内容后分批导入';
    expect(await rowsOf([importHeader, ...template(`${note}x`)])).toEqual({ error: tooLarge });
    expect(await rowsOf([importHeader, ...template(`${note}合`)])).toEqual({ error: tooLarge });
  });

  it('异常列坐标、压缩炸弹、单元格过多：及时以 XlsxError 中止，不把超长数组或超大文本交给后续解析', async () => {
    const head = importHeader.slice(0, 5);
    const rejected = async (rowsXml: string, reason: string) => {
      const bytes = await buildXlsx([head, H0003], { rowsXml });
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

  it('预先铺好格式的模板：100 行数据 + 尾部 7,200 行 × 14 列带填充样式的空白格，解析后恰好 100 行', async () => {
    // 空白格 7,200 × 14 = 100,800 个：只有样式、没有值，不算有效数据，不能据此整份拒绝
    const bytes = await buildXlsx([importHeader, ...requiredRows(100)], { rowsXml: styledBlankRowsXml(102, 7_200) });
    const parsed = importRowsOf(await readXlsx(bytes));
    expect('rows' in parsed ? parsed.rows.length : parsed.error).toBe(100);
    expect('rows' in parsed && parsed.rows[99]).toMatchObject({ rowNo: 101, employeeNo: 'H0100' });
  });

  it('预先铺好格式的模板：尾部 7,200 行 × 14 列设为空字符串的格式格（空 inlineStr 等）同样按空白格，解析后恰好 100 行', async () => {
    // openpyxl 把空字符串写成 <c r="A102" s="1" t="inlineStr"></c>：回读为空白，不占有值格与展开预算
    for (const mixed of [false, true]) {
      const head = [importHeader, ...requiredRows(100)];
      const sheet = await readXlsx(await buildXlsx(head, { rowsXml: emptyTextRowsXml(102, 7_200, mixed) }));
      expect(sheet.rows).toHaveLength(101);
      const parsed = importRowsOf(sheet);
      expect('rows' in parsed ? parsed.rows.length : parsed.error).toBe(100);
      expect('rows' in parsed && parsed.rows[99]).toMatchObject({ rowNo: 101, employeeNo: 'H0100' });
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
    const valued = await buildXlsx([importHeader.slice(0, 5), requiredRows(1)[0]!], {
      rowsXml: xfdRowsXml(3, 10_000, 1),
    });
    const again = performance.now();
    await expect(readXlsx(valued)).rejects.toMatchObject({ name: 'XlsxError', reason: 'limit' });
    expect(performance.now() - again).toBeLessThan(2000);
  });

  it('超编区间的 to 是开区间（离职生效日），显示为最后一个在职日', () => {
    expect(warningText(warning)).toBe('2023-04-01 至 2025-07-31 超出编制（峰值 6，编制 5）');
  });
});
