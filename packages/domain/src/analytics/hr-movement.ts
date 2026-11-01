/**
 * 人事分析第 2 段 BE-13b 的目录与纯规则（docs/02_业务建模/35“补充：BE-13…”B50、“流动情况各报表的算法”B54）：
 * 只放不含 IO 的标识、名称、月份切分与比率公式；取数在 apps/api 的 analytics/hr-movement*.ts。
 * 两个只读授权对象在 permission/module-actions.ts 登记（授权项“人事分析 - <名> 查看”）。
 */
import type { BoardComponentKind } from './hr-structure.js';

export const HR_MOVEMENT_OBJECT = 'TenantBase.HrMovement';
export const HR_MOVEMENT_REPORT_OBJECT = 'TenantBase.HrMovementReport';

/**
 * series = 按月的分组序列（没有单一数值，明细须指定月份分组）；table = 按编制对象一行的多列表格（3.1.36，
 * 明细须指定编制对象分组）；其余形态同 BE-13a。
 */
export type MovementComponentKind = BoardComponentKind | 'series' | 'table';

/** B50 人员流动分析 6.25～6.32 与 3.1.36（编号即规格编号）。 */
export const HR_MOVEMENT_COMPONENTS = [
  { code: '6.25', name: '近 12 个月各月期末人数', kind: 'series' },
  { code: '6.26', name: '近 12 月入离职统计', kind: 'series' },
  { code: '6.27', name: '近 12 个月调动统计', kind: 'groups' },
  { code: '6.28', name: '近 12 月各月离职率', kind: 'series' },
  { code: '6.29', name: '近 12 个月离职原因统计', kind: 'groups' },
  { code: '6.30', name: '近 12 个月离职去向统计', kind: 'groups' },
  { code: '6.31', name: '近 12 月离职人员司龄分布', kind: 'groups' },
  { code: '6.32', name: '入职一个月内离职各部门人数占比', kind: 'ratio' },
  // 编制与实有人员取编制模块与时点在职；预增 / 预减按组织汇总的读接口尚未抽出（F-418），这四列整列 null
  { code: '3.1.36', name: '编制统计表', kind: 'table' },
] as const satisfies readonly { code: string; name: string; kind: MovementComponentKind }[];
export type HrMovementCode = (typeof HR_MOVEMENT_COMPONENTS)[number]['code'];

/** B54 流动情况六个页签；组织编制与 3.1.36 同口径（预增 / 预减等四列 null，F-418）。 */
export const HR_MOVEMENT_REPORTS = [
  { code: 'flow', name: '员工流动统计', kind: 'table' },
  { code: 'monthly', name: '各月入离职统计', kind: 'table' },
  { code: 'institution', name: '各机构入离职统计', kind: 'table' },
  { code: 'inflow', name: '员工流入统计', kind: 'table' },
  { code: 'outflow', name: '员工流出统计', kind: 'table' },
  { code: 'establishment', name: '组织编制统计', kind: 'table' },
] as const;
export type HrMovementReportCode = (typeof HR_MOVEMENT_REPORTS)[number]['code'];

/** 退休没有离职类型 / 原因 / 去向：6.29 / 6.30 与流出统计把它归入“退休”这一类型（原因、去向为空）。 */
export const MOVEMENT_RETIREMENT_TYPE = { code: 'retirement', name: '退休' } as const;

/** 统计月：key = YYYY-MM；start = 当月 1 日；end = 月末与 asOf 中较早者（本月期末即 asOf 当天）。 */
export interface MovementMonth {
  readonly key: string;
  readonly start: string;
  readonly end: string;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');
const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/**
 * 第 n 个月（n = 年 × 12 + 月 − 1），end 不超过 asOf。年份补足 4 位、月末按当月天数算（不经 Date 进位到下个月），
 * 合法 asOf 的边界 0001-01 / 9999-12 也能算（审查 P2-6）。
 */
function monthOf(n: number, asOf: string): MovementMonth {
  const year = Math.floor(n / 12);
  const month = (n % 12) + 1;
  const prefix = `${pad(year, 4)}-${pad(month)}`;
  const last = `${prefix}-${pad(month === 2 && leap(year) ? 29 : DAYS[month - 1]!)}`;
  return { key: prefix, start: `${prefix}-01`, end: last < asOf ? last : asOf };
}
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** 近 n 个月（含 asOf 所在月），从早到晚；窗口早于公元 1 年 1 月（asOf 在 0001 年）时为 null，由调用方报 400。 */
export function movementMonths(asOf: string, count = 12): MovementMonth[] | null {
  const first = monthIndex(asOf) - count + 1;
  if (first < 12) return null;
  return Array.from({ length: count }, (_, index) => monthOf(first + index, asOf));
}

/** 某年 12 个月；asOf 之后开始的月份为 null（报表单元格整行为空，不推算未来）。 */
export function yearMonths(year: number, asOf: string): (MovementMonth | null)[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = monthOf(year * 12 + index, asOf);
    return month.start > asOf ? null : month;
  });
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** 离职率 = 离职 ÷ ((期初 + 期末) ÷ 2)，平均人数为 0 时为 0（原站 IFERROR 为 0），保留 4 位小数。 */
export function leaveRate(exits: number, opening: number, closing: number): number {
  const average = (opening + closing) / 2;
  return average ? round4(exits / average) : 0;
}

/** 绝对增长率 = 净增长 × 2 ÷ (年初 + 年底)，即净增长 ÷ 平均人数；平均人数为 0 时为 0。 */
export function growthRate(net: number, start: number, end: number): number {
  return start + end ? round4((net * 2) / (start + end)) : 0;
}

/** 入职一个月内离职：累计司龄（入职日到最后工作日的天数 ÷ 365，不取整）≤ 0.083 年。 */
export const ONE_MONTH_YEARS = 0.083;
export function withinOneMonth(entryDate: string | null, lastWorkDate: string): boolean {
  if (!entryDate || entryDate > lastWorkDate) return false;
  const days = (Date.parse(`${lastWorkDate}T00:00:00Z`) - Date.parse(`${entryDate}T00:00:00Z`)) / 86_400_000;
  return days / 365 <= ONE_MONTH_YEARS;
}
