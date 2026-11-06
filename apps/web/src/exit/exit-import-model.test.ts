// AC-DM-30-19（对应设计 AC-DM-30-13）：Excel → 请求行的文件级拒绝；逐行校验的权威在服务端，前端不重复。
import { describe, expect, it } from 'vitest';
import { importRowsOf, warningText } from './exit-import-model.js';
import {
  buildXlsx,
  importHeader,
  importRows,
  importSheet,
  warning,
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

  it('缺必填列、未知列、重复列、空文件、超过 100 行、加入黑名单非法值都整份拒绝', async () => {
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
    expect(await rowsOf([head, ...Array.from({ length: 101 }, () => H0003)])).toEqual({ error: '一次最多导入 100 行' });
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

  it('超编区间的 to 是开区间（离职生效日），显示为最后一个在职日', () => {
    expect(warningText(warning)).toBe('2023-04-01 至 2025-07-31 超出编制（峰值 6，编制 5）');
  });
});
