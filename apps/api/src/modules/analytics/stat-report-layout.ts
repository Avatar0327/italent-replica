/**
 * 三张统计报表（各月入离职统计 / 各机构入离职统计 / 员工素质结构）的导出版式（F-482，规格 35“统计报表导出”）。
 * 输入是页面接口同一份结果（行与计数列逐格相同），这里只摆格子：标题、表头、合计 / 月均行、填报人 / 日期 / 说明。
 * 数值一律不取整——页面的离职率（4 位小数）与平均值（1 位）是显示口径，文件里的比率由计数列重新算（原站取证：数值不取整）。
 * 两种下载方式数值相同：「仅下载数据」全是值；「含公式」的比率是 IFERROR、合计 / 月均是 SUM / AVERAGE，并带缓存值，
 * 不加隐藏行列（evidence §4，原站公式版的隐藏行列没有取证到用途，复刻不虚构）。
 */
import { columnLetters, StatSheet, type ExportMode, type StatCell } from './stat-xlsx.js';

export interface ExportStamp {
  readonly mode: ExportMode;
  /** 填报人 = 导出人的姓名；填报日期 = 导出当天（租户时区）。 */
  readonly exporter: string;
  readonly today: string;
}
interface Rowed {
  readonly label: string;
  readonly cells: Readonly<Record<string, number | null>>;
}
const COUNT_KEYS = ['opening', 'hires', 'exits', 'closing'] as const;
const VALUE_COLUMNS = ['C', 'D', 'E', 'F'] as const; // 期初 入职 离职 期末；G = 离职率
const HEADER = ['期初人数', '入职人数', '离职人数', '期末人数', '离职率'];
const RATE_NOTE = '离职率=离职人数/(期初人数+期末人数)*2*100%';
const QUALITY_NOTE =
  '司龄段统计规则为向下包含，下限闭区间：如「1~2年」指司龄满 1 年且不满 2 年；司龄含校正值，按月向下取整。';

/** 离职率 = 离职 × 2 ÷ (期初 + 期末)，分母为 0 时 0（原站 IFERROR 为 0）；不取整。 */
const rateOf = (exits: number, opening: number, closing: number) =>
  opening + closing === 0 ? 0 : (exits * 2) / (opening + closing);

function rateCell(
  row: number,
  mode: ExportMode,
  values: { exits: number; opening: number; closing: number },
): StatCell {
  const value = rateOf(values.exits, values.opening, values.closing);
  return mode === 'formula' ? { value, formula: `IFERROR(E${row}/(C${row}+F${row})*2,0)` } : value;
}
function writeCounts(sheet: StatSheet, row: number, counts: Record<(typeof COUNT_KEYS)[number], number>) {
  VALUE_COLUMNS.forEach((column, index) => sheet.set(`${column}${row}`, counts[COUNT_KEYS[index]!]));
}

/** 页脚：空一行后依次是填报人、填报日期、说明（整行合并到 lastColumn）。 */
function footer(sheet: StatSheet, from: number, lastColumn: string, note: string, stamp: ExportStamp) {
  sheet.set(`B${from}`, `填报人：${stamp.exporter}`);
  sheet.set(`B${from + 1}`, `填报日期：${stamp.today}`);
  sheet.set(`B${from + 2}`, note);
  sheet.merge(`B${from + 2}:${lastColumn}${from + 2}`);
}

/** 各月入离职统计：C1 年份、D1:G1「年各月入离职统计」；第 2 行表头；每月一行（asOf 之后的月份留空）；「月均」行。 */
export function monthlySheet(year: number, rows: readonly Rowed[], stamp: ExportStamp): StatSheet {
  const sheet = new StatSheet();
  sheet.set('C1', year);
  sheet.set('D1', '年各月入离职统计');
  sheet.merge('D1:G1');
  ['月份', ...HEADER].forEach((text, index) => sheet.set(`${columnLetters(2 + index)}2`, text));
  const arrived: Record<(typeof COUNT_KEYS)[number], number>[] = [];
  rows.forEach((row, index) => {
    const at = 3 + index;
    sheet.set(`B${at}`, row.label);
    if (row.cells.opening === null || row.cells.opening === undefined) return;
    const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, row.cells[key] ?? 0])) as (typeof arrived)[number];
    arrived.push(counts);
    writeCounts(sheet, at, counts);
    sheet.set(`G${at}`, rateCell(at, stamp.mode, counts));
  });
  // 月均 = 已到月份的平均（asOf 之后的月份留空，AVERAGE 同样忽略空格）；没有已到月份时全 0
  const means = Object.fromEntries(
    COUNT_KEYS.map((key) => [
      key,
      arrived.length ? arrived.reduce((sum, item) => sum + item[key], 0) / arrived.length : 0,
    ]),
  ) as (typeof arrived)[number];
  const last = 3 + rows.length;
  sheet.set(`B${last}`, '月均');
  VALUE_COLUMNS.forEach((column, index) => {
    const value = means[COUNT_KEYS[index]!];
    sheet.set(
      `${column}${last}`,
      stamp.mode === 'formula' ? { value, formula: `AVERAGE(${column}3:${column}${last - 1})` } : value,
    );
  });
  sheet.set(`G${last}`, rateCell(last, stamp.mode, means));
  footer(sheet, last + 2, 'G', RATE_NOTE, stamp);
  return sheet;
}

/** 各机构入离职统计：B1:G1 标题，第 2 行年份 / 月份，第 3 行表头；一级机构行；合计行。 */
export function institutionSheet(
  period: { readonly year: number; readonly month: number },
  rows: readonly (Rowed & { readonly cells: Record<string, number | null> })[],
  stamp: ExportStamp,
): StatSheet {
  const sheet = new StatSheet();
  sheet.set('B1', '各机构入离职统计');
  sheet.merge('B1:G1');
  sheet.set('B2', `年份：${period.year}`);
  sheet.set('C2', `月份：${period.month}`);
  ['一级机构', ...HEADER].forEach((text, index) => sheet.set(`${columnLetters(2 + index)}3`, text));
  const sums = { opening: 0, hires: 0, exits: 0, closing: 0 };
  rows.forEach((row, index) => {
    const line = 4 + index;
    const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, row.cells[key] ?? 0])) as typeof sums;
    sheet.set(`B${line}`, row.label);
    writeCounts(sheet, line, counts);
    sheet.set(`G${line}`, rateCell(line, stamp.mode, counts));
    for (const key of COUNT_KEYS) sums[key] += counts[key];
  });
  const total = 4 + rows.length;
  sheet.set(`B${total}`, '合计');
  VALUE_COLUMNS.forEach((column, index) => {
    const value = sums[COUNT_KEYS[index]!];
    // 没有数据行时没有可求和的区域，直接写 0，不写 SUM(C4:C3) 这类无效区间
    const summed = stamp.mode === 'formula' && rows.length > 0;
    sheet.set(`${column}${total}`, summed ? { value, formula: `SUM(${column}4:${column}${total - 1})` } : value);
  });
  sheet.set(`G${total}`, rateCell(total, stamp.mode, sums));
  footer(sheet, total + 2, 'G', RATE_NOTE, stamp);
  return sheet;
}

interface QualityPage {
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly rows: readonly { readonly organizationName: string; readonly cells: Record<string, number | null> }[];
  readonly summary: { readonly cells: Record<string, number | null> };
}
const GROUPS = [
  { from: 'E', to: 'F', label: '性别' },
  { from: 'G', to: 'J', label: '学历' },
  { from: 'K', to: 'P', label: '司龄段' },
  { from: 'R', to: 'W', label: '年龄段' },
];
const SINGLES: [string, string][] = [
  ['B', '一级组织'],
  ['C', '序号'],
  ['D', '合计'],
  ['Q', '平均司龄'],
  ['X', '平均年龄'],
];
const AVERAGE_KEYS = ['avgTenure', 'avgAge'];

/** 员工素质结构：B1:X1 标题；两级表头靠合并单元格；一级组织行（序号从 1）；「合计」行（序号空）。 */
export function qualitySheet(page: QualityPage, stamp: ExportStamp): StatSheet {
  const sheet = new StatSheet();
  sheet.set('B1', '员工素质结构统计');
  sheet.merge('B1:X1');
  for (const [column, text] of SINGLES) {
    sheet.set(`${column}2`, text);
    sheet.merge(`${column}2:${column}3`);
  }
  for (const group of GROUPS) {
    sheet.set(`${group.from}2`, group.label);
    sheet.merge(`${group.from}2:${group.to}2`);
  }
  // 页面 21 列（合计 … 平均年龄）依次落在 D … X；第 2 行已写的单列表头不重复写第 3 行
  const letters = page.columns.map((_, index) => columnLetters(4 + index));
  page.columns.forEach((column, index) => {
    const letter = letters[index]!;
    if (!SINGLES.some(([single]) => single === letter)) sheet.set(`${letter}3`, column.label);
  });
  const put = (line: number, cells: Record<string, number | null>, only?: (key: string) => boolean) =>
    page.columns.forEach((column, index) => {
      if (!only || only(column.key)) sheet.set(`${letters[index]}${line}`, cells[column.key]);
    });
  page.rows.forEach((row, index) => {
    sheet.set(`B${4 + index}`, row.organizationName);
    sheet.set(`C${4 + index}`, index + 1);
    put(4 + index, row.cells);
  });
  const total = 4 + page.rows.length;
  sheet.set(`B${total}`, '合计');
  // 计数列合计写 SUM（19 个）；平均值不可加，写值（取页面合计的不取整结果）
  put(total, page.summary.cells, (key) => AVERAGE_KEYS.includes(key));
  page.columns.forEach((column, index) => {
    if (AVERAGE_KEYS.includes(column.key)) return;
    const letter = letters[index]!;
    const value = page.summary.cells[column.key] ?? 0;
    const summed = stamp.mode === 'formula' && page.rows.length > 0;
    sheet.set(`${letter}${total}`, summed ? { value, formula: `SUM(${letter}4:${letter}${total - 1})` } : value);
  });
  footer(sheet, total + 2, 'J', QUALITY_NOTE, stamp);
  return sheet;
}
