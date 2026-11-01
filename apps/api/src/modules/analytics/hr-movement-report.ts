/**
 * 流动情况报表六个页签（docs/02_业务建模/35“流动情况各报表的算法”B54）：行 × 列，单元格是对一组记录求值的列函数，
 * 行与合计共用同一列函数。期初 / 期末各按日期取时点人数（不用“上期期末 + 入职 − 离职”推算）；流入 / 流出按任职记录
 * 开始日期取（离职记录始于最后工作日次日），口径内部员工 + 实习生；组织编制没有数据源，返回 unavailable。
 */
import {
  AGE_SEGMENTS,
  ageSample,
  ageSegment,
  EDUCATION_TIERS,
  educationTier,
  GENDER_SEGMENTS,
  genderSegment,
  growthRate,
  leaveRate,
  SEGMENT_NONE,
  segmentAverage,
  TENURE_SEGMENTS,
  tenureSample,
  tenureSegment,
  yearMonths,
  type HrMovementReportCode,
  type MovementMonth,
} from '@italent/domain';
import {
  closing,
  exitReason,
  exitsIn,
  exitType,
  hiresIn,
  NONE_LABEL,
  opening,
  unique,
  type Member,
} from './hr-movement-board.js';
import type { MovementData, MovementExit, MovementHire, MovementPerson } from './hr-movement.js';
import type { DictionaryItem, OrgTree } from './hr-structure.js';

/** 报表期间：year 年（本年截至 asOf）；institution 只看 month 月。 */
export interface ReportPeriod {
  readonly year: number;
  readonly month: number | null;
  readonly asOf: string;
}

/** 一个统计格的全部记录：期初 / 期末人员与期间内的入职、调动、离职。 */
interface Slice {
  readonly opening: readonly Member[];
  readonly closing: readonly Member[];
  readonly hires: readonly MovementHire[];
  readonly transfers: readonly Member[];
  readonly exits: readonly MovementExit[];
}
interface Column<T> {
  readonly key: string;
  readonly label: string;
  readonly value: (group: T) => number | null;
}
interface Row<T> {
  readonly key: string;
  readonly label: string;
  readonly group: T | null;
}

function table<T>(key: string, name: string, columns: readonly Column<T>[], rows: readonly Row<T>[], all: T) {
  const cells = (group: T | null) =>
    Object.fromEntries(columns.map((column) => [column.key, group === null ? null : column.value(group)]));
  return {
    key,
    name,
    columns: columns.map(({ key: k, label }) => ({ key: k, label })),
    rows: rows.map((row) => ({ key: row.key, label: row.label, cells: cells(row.group) })),
    summary: { cells: cells(all) },
  };
}

/** 时点人数只在期初 / 期末用到：各月页签取每月首尾两天，流动 / 各机构取期间首尾，流入 / 流出不取时点。 */
function snapshotDays(code: HrMovementReportCode, months: readonly MovementMonth[], span: MovementMonth) {
  if (code === 'monthly') return months.flatMap((m) => [m.start, m.end]);
  if (code === 'flow' || code === 'institution') return [span.start, span.end];
  return [];
}

/** 期间 [from, to]；年度报表 to = 年底与 asOf 较早者，月份报表为该月。 */
export function reportWindow(code: HrMovementReportCode, period: ReportPeriod) {
  const months = yearMonths(period.year, period.asOf).filter((m): m is MovementMonth => m !== null);
  const year: MovementMonth = { key: `${period.year}`, start: months[0]!.start, end: months.at(-1)!.end };
  const span = code === 'institution' ? months[(period.month ?? 12) - 1]! : year;
  return { span, days: snapshotDays(code, months, span), from: span.start, to: span.end };
}

const EMPTY_SLICE: Slice = { opening: [], closing: [], hires: [], transfers: [], exits: [] };

function slice(data: MovementData, span: MovementMonth): Slice {
  return {
    opening: opening(data, span.start),
    closing: closing(data, span),
    hires: hiresIn(data, span),
    transfers: unique(data.transfers.filter((t) => t.effectiveDate >= span.start && t.effectiveDate <= span.end)),
    exits: exitsIn(data, span),
  };
}

/** 按组织分行：每类记录按自己的归属部门映射到行键（键为 null 的记录不进任何行，但仍计入合计）。 */
function sliceBy(whole: Slice, rowOf: (departmentId: string | null) => string | null) {
  const rows = new Map<string, { [K in keyof Slice]: Slice[K][number][] }>();
  for (const part of ['opening', 'closing', 'hires', 'transfers', 'exits'] as const)
    for (const item of whole[part]) {
      const key = rowOf(item.departmentId);
      if (key === null) continue;
      const row = rows.get(key) ?? { opening: [], closing: [], hires: [], transfers: [], exits: [] };
      (row[part] as Member[]).push(item);
      rows.set(key, row);
    }
  return rows as Map<string, Slice>;
}
const orgRows = (rows: Map<string, Slice>, tree: OrgTree): Row<Slice>[] =>
  [...rows.entries()]
    .map(([key, group]) => ({ key, label: tree.name(key), group }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh') || a.key.localeCompare(b.key));

const size = (key: string, label: string, pick: (s: Slice) => readonly unknown[]): Column<Slice> => ({
  key,
  label,
  value: (s) => pick(s).length,
});
const monthColumns: Column<Slice>[] = [
  size('opening', '期初人数', (s) => s.opening),
  size('hires', '入职人数', (s) => s.hires),
  size('exits', '离职人数', (s) => s.exits),
  size('closing', '期末人数', (s) => s.closing),
  { key: 'rate', label: '离职率', value: (s) => leaveRate(s.exits.length, s.opening.length, s.closing.length) },
];
const net = (s: Slice) => s.closing.length - s.opening.length;
const flowColumns: Column<Slice>[] = [
  size('yearStart', '年初人数', (s) => s.opening),
  size('hires', '入职人数', (s) => s.hires),
  size('transfers', '调动人数', (s) => s.transfers),
  size('exits', '离职人数', (s) => s.exits),
  size('yearEnd', '年底人数', (s) => s.closing),
  { key: 'netGrowth', label: '净增长', value: net },
  { key: 'growthRate', label: '绝对增长率', value: (s) => growthRate(net(s), s.opening.length, s.closing.length) },
  { key: 'totalChange', label: '累计变动量', value: (s) => s.hires.length + s.transfers.length + s.exits.length },
];

// ---- 流入 / 流出：职务序列 × 人员属性 -------------------------------------------------------------------------------

const count = <T>(key: string, label: string, test: (item: T) => boolean): Column<readonly T[]> => ({
  key,
  label,
  value: (items) => items.filter(test).length,
});
function profileColumns<T extends MovementPerson>(): Column<readonly T[]>[] {
  return [
    { key: 'total', label: '合计', value: (items) => items.length },
    ...GENDER_SEGMENTS.slice(0, 2).map((g) =>
      count<T>(`gender:${g.key}`, g.label, (p) => genderSegment(p.gender) === g.key),
    ),
    ...EDUCATION_TIERS.map((t) =>
      count<T>(`education:${t.key}`, t.label, (p) => educationTier(p.educationLevel) === t.key),
    ),
  ];
}
function sequenceRows<T extends MovementPerson>(items: readonly T[], sequences: readonly DictionaryItem[]) {
  const keyOf = (p: T) => p.sequenceId ?? SEGMENT_NONE;
  const present = new Set(items.map(keyOf));
  const known = sequences.filter((s) => present.has(s.id)).map((s) => ({ key: s.id, label: s.name }));
  const other = [...present]
    .filter((key) => key !== SEGMENT_NONE && !known.some((s) => s.key === key))
    .sort()
    .map((key) => ({ key, label: key }));
  const none = present.has(SEGMENT_NONE) ? [{ key: SEGMENT_NONE, label: NONE_LABEL }] : [];
  return [...known, ...other, ...none].map((row) => ({ ...row, group: items.filter((p) => keyOf(p) === row.key) }));
}

function inflow(hires: readonly MovementHire[], sequences: readonly DictionaryItem[], asOf: string) {
  const columns: Column<readonly MovementHire[]>[] = [
    ...profileColumns<MovementHire>(),
    ...AGE_SEGMENTS.map((s) =>
      count<MovementHire>(`age:${s.key}`, s.label, (p) => ageSegment(p.birthday, asOf) === s.key),
    ),
    {
      key: 'averageAge',
      label: '平均年龄',
      value: (items) => segmentAverage(items.map((p) => ageSample(p.birthday, asOf)).filter((v) => v !== null)),
    },
  ];
  return [table('inflow', '员工流入统计', columns, sequenceRows(hires, sequences), hires)];
}

const presentCodes = (exits: readonly MovementExit[], pick: (e: MovementExit) => { key: string; label: string }) => {
  const codes = new Map(exits.map((e) => [pick(e).key, pick(e).label]));
  codes.delete(SEGMENT_NONE);
  return [...codes].sort(([a], [b]) => a.localeCompare(b));
};

function outflow(exits: readonly MovementExit[], sequences: readonly DictionaryItem[]) {
  const reasonKey = (e: MovementExit) => `${exitType(e).key}|${exitReason(e).key}`;
  const reasonRows = [...new Map(exits.map((e) => [reasonKey(e), e])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => ({
      key,
      label: `${exitType(e).label} / ${exitReason(e).label}`,
      group: exits.filter((item) => reasonKey(item) === key),
    }));
  const columns: Column<readonly MovementExit[]>[] = [
    ...profileColumns<MovementExit>(),
    ...TENURE_SEGMENTS.map((s) =>
      count<MovementExit>(`tenure:${s.key}`, s.label, (e) => tenureSegment(e.entryDate, e.lastWorkDate) === s.key),
    ),
    {
      key: 'averageTenure',
      label: '平均司龄',
      value: (items) =>
        segmentAverage(items.map((e) => tenureSample(e.entryDate, e.lastWorkDate)).filter((v) => v !== null)),
    },
    ...presentCodes(exits, exitType).map(([key, label]) =>
      count<MovementExit>(`type:${key}`, label, (e) => exitType(e).key === key),
    ),
    ...presentCodes(exits, exitReason).map(([key, label]) =>
      count<MovementExit>(`reason:${key}`, label, (e) => exitReason(e).key === key),
    ),
    count<MovementExit>('keyPerson', '关键人员', (e) => e.keyPerson),
  ];
  return [
    table(
      'reasons',
      '离职类型与原因',
      [{ key: 'count', label: '人数', value: (items) => items.length }],
      reasonRows,
      exits,
    ),
    table('sequences', '离职人员属性', columns, sequenceRows(exits, sequences), exits),
  ];
}

export interface ReportLookup {
  readonly tree: OrgTree;
  readonly data: MovementData;
  readonly sequences: readonly DictionaryItem[];
  /** 流动统计按组织层级下钻：给出时行 = 该组织的直接下级（人员直接挂在它上面时归它自己）。 */
  readonly parentId?: string;
}

/** 一个页签的表格；组织编制没有数据源返回 null。 */
export function movementReport(code: HrMovementReportCode, period: ReportPeriod, x: ReportLookup) {
  const { span } = reportWindow(code, period);
  const whole = slice(x.data, span);
  switch (code) {
    case 'flow': {
      const rowOf = (departmentId: string | null) => {
        if (!x.parentId) return x.tree.level1(departmentId);
        const chain = x.tree.chain(departmentId);
        const at = chain.indexOf(x.parentId);
        return at < 0 ? null : (chain[Math.max(at - 1, 0)] ?? null);
      };
      const rows = sliceBy(whole, rowOf);
      // 合计只算进了某一行的记录（下钻时 parentId 以外的不算）；不下钻时每条都进一级组织行，即全部
      const all = sliceBy(whole, (d) => (rowOf(d) === null ? null : 'all')).get('all') ?? EMPTY_SLICE;
      return [table('flow', '员工流动统计', flowColumns, orgRows(rows, x.tree), all)];
    }
    case 'monthly': {
      const months = yearMonths(period.year, period.asOf);
      const rows = months.map((m, index) => {
        const key = `${period.year}-${String(index + 1).padStart(2, '0')}`;
        return { key, label: key, group: m ? slice(x.data, m) : null };
      });
      return [table('monthly', '各月入离职统计', monthColumns, rows, whole)];
    }
    case 'institution':
      return [
        table('institution', '各机构入离职统计', monthColumns, orgRows(sliceBy(whole, x.tree.level1), x.tree), whole),
      ];
    case 'inflow':
      return inflow(whole.hires, x.sequences, period.asOf);
    case 'outflow':
      return outflow(whole.exits, x.sequences);
    case 'establishment':
      return null;
  }
}
