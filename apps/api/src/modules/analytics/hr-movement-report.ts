/**
 * 流动情况报表六个页签（docs/02_业务建模/35“流动情况各报表的算法”B54）：行 × 列，单元格是对一组记录求值的列函数，
 * 行与合计共用同一列函数。期初、期末按各自日期取时点（规格 35 第 122 行），不用“上期期末 + 入职 − 离职”推算，
 * 也不保证收支等式；流入按入职任职记录开始日期、流出按最后工作日归年 / 归月（与人事看板“本年离职”一致，DEC-729），
 * 口径内部员工 + 实习生。
 * 聚合契约（第 3 轮）：年度各表（流动统计、各机构、流入、流出）按人数，读 data.window——同一员工窗口内多次入职 / 调动 /
 * 离职只计一次，归入最后一次（单一入口 attributeWindow，hr-movement.ts），与人事看板“本年离职”同为人数；
 * 各月入离职表读原始行、每月内按员工去重，页尾 = 已到月份行之和。月表合计按月累加；年度各表按人数，重聘同年多次离职时
 * 二者可不等。
 * 组织编制取所选年度取数日（年底与 asOf 较早者）的组织编制与同日实有人员（含下级），预增员 / 预减员等四列整列 null（F-418）。
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
  MOVEMENT_RETIREMENT_TYPE,
  SEGMENT_NONE,
  segmentAverage,
  TENURE_SEGMENTS,
  tenureSample,
  tenureSegment,
  yearMonths,
  type HrMovementReportCode,
  type MovementMonth,
} from '@italent/domain';
import { actualStaff, exitReason, exitType, NONE_LABEL, unique, type Member } from './hr-movement-board.js';
import type {
  ExitDictionaries,
  MovementData,
  MovementEstablishment,
  MovementExit,
  MovementHire,
  MovementPerson,
  MovementRecords,
} from './hr-movement.js';
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

/**
 * 时点人数只在期初 / 期末与编制实有人员用到：各月页签取每月首尾两天，流动 / 各机构取期间首尾，组织编制取年度取数日
 * （年底与 asOf 较早者），流入 / 流出不取时点。
 */
function snapshotDays(code: HrMovementReportCode, months: readonly MovementMonth[], span: MovementMonth) {
  if (code === 'monthly') return months.flatMap((m) => [m.start, m.end]);
  if (code === 'flow' || code === 'institution') return [span.start, span.end];
  if (code === 'establishment') return [span.end];
  return [];
}

/** 期间 [from, to]；年度报表 to = 年底与 asOf 较早者，月份报表为该月。 */
export function reportWindow(code: HrMovementReportCode, period: ReportPeriod) {
  const months = yearMonths(period.year, period.asOf).filter((m): m is MovementMonth => m !== null);
  const year: MovementMonth = { key: `${period.year}`, start: months[0]!.start, end: months.at(-1)!.end };
  const span = code === 'institution' ? months[(period.month ?? 12) - 1]! : year;
  const window = { days: snapshotDays(code, months, span), from: span.start, to: span.end };
  return { span, ...window, exitDating: 'lastWorkDate' as const };
}

const PARTS = ['opening', 'closing', 'hires', 'transfers', 'exits'] as const;
const EMPTY_SLICE: Slice = { opening: [], closing: [], hires: [], transfers: [], exits: [] };
const inSpan = (date: string, span: MovementMonth) => date >= span.start && date <= span.end;

/**
 * 期间内的记录：期初 = 期间首日的时点在职（报表按最后工作日归期，最后工作日当天仍在职，不再补“当天离职生效”的人），
 * 期末 = 期间末日时点在职，离职按最后工作日落在期间内。records 是年度表的 data.window（每人一条）或月表的原始行。
 */
function rawSlice(data: MovementData, span: MovementMonth, records: MovementRecords): Slice {
  return {
    opening: data.snapshots.get(span.start) ?? [],
    closing: data.snapshots.get(span.end) ?? [],
    hires: records.hires.filter((h) => inSpan(h.startDate, span)),
    transfers: records.transfers.filter((t) => inSpan(t.effectiveDate, span)),
    exits: records.exits.filter((e) => inSpan(e.lastWorkDate, span)),
  };
}
/** 一个统计格内按员工去重（月表同一人一个月内多条只算一次；年度表的记录已是每人一条）。 */
const dedupe = (raw: Slice): Slice => ({
  opening: unique(raw.opening),
  closing: unique(raw.closing),
  hires: unique(raw.hires),
  transfers: unique(raw.transfers),
  exits: unique(raw.exits),
});

/**
 * 按组织分行：每类记录按自己的归属部门映射到行键，先分组再在各格内去重。入职 / 调动 / 离职已按窗口归属到每人最后一条，
 * 重聘跨部门时只进最后一次的组织行（全表组织行 = 单独筛选该组织，审查 P2-7）；期初 / 期末是时点，按当天部门。
 * 键为 null 的记录不进任何行；员工流动下钻（parentId）时，parentId 以外的记录键为 null，合计同样不计（审查 P3-2）。
 */
function sliceBy(raw: Slice, rowOf: (departmentId: string | null) => string | null) {
  const rows = new Map<string, { [K in keyof Slice]: Slice[K][number][] }>();
  for (const part of PARTS)
    for (const item of raw[part]) {
      const key = rowOf(item.departmentId);
      if (key === null) continue;
      const row = rows.get(key) ?? { opening: [], closing: [], hires: [], transfers: [], exits: [] };
      (row[part] as Member[]).push(item);
      rows.set(key, row);
    }
  return new Map([...rows].map(([key, row]) => [key, dedupe(row as Slice)]));
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
/** 序列行：先按序列分组、再在行内按员工去重（items 是未去重的记录，同 sliceBy）。 */
function sequenceRows<T extends MovementPerson>(items: readonly T[], sequences: readonly DictionaryItem[]) {
  const keyOf = (p: T) => p.sequenceId ?? SEGMENT_NONE;
  const present = new Set(items.map(keyOf));
  const known = sequences.filter((s) => present.has(s.id)).map((s) => ({ key: s.id, label: s.name }));
  const other = [...present]
    .filter((key) => key !== SEGMENT_NONE && !known.some((s) => s.key === key))
    .sort()
    .map((key) => ({ key, label: key }));
  const none = present.has(SEGMENT_NONE) ? [{ key: SEGMENT_NONE, label: NONE_LABEL }] : [];
  return [...known, ...other, ...none].map((row) => ({
    ...row,
    group: unique(items.filter((p) => keyOf(p) === row.key)),
  }));
}

/** hires 为窗口归属后的入职（每人一条）。 */
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
  return [table('inflow', '员工流入统计', columns, sequenceRows(hires, sequences), unique(hires))];
}

/**
 * 离职类型 / 原因列（审查 P2-8）：租户字典的启用项（按显示顺序，未用到的填 0），再补期间内出现但不在启用字典里的编码
 * （已停用等）。编码按小写匹配字典（与离职列表的字典关联同口径）。code 为 null（空值、退休没有类型 / 原因）不进任何列，
 * 字典里真实存在的编码 none 照常计数（第 3 轮审查）；退休另起独立列，见 outflow。
 */
function codeColumns(
  exits: readonly MovementExit[],
  dictionary: readonly { code: string; name: string }[],
  pick: (e: MovementExit) => { code: string | null; label: string },
) {
  const known = new Map(dictionary.map((item) => [item.code.toLowerCase(), item]));
  const keyOf = (e: MovementExit) => {
    const { code } = pick(e);
    return code === null ? null : (known.get(code.toLowerCase())?.code ?? code);
  };
  const present = new Map<string, string>();
  for (const e of exits) {
    const key = keyOf(e);
    if (key !== null && !present.has(key)) present.set(key, pick(e).label);
  }
  const others = [...present]
    .filter(([key]) => !known.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, name]) => ({ code, name }));
  return { keyOf, columns: [...dictionary, ...others] };
}

/**
 * exits 为窗口归属后的离职（每人一条，类型 / 原因取最后一次）。原因行键 = JSON 元组 [...离职类型段, 原因编码 | null]；
 * 类型列只数离职（kind = leave），退休单独一列（键 retirement，与字典编码 retirement 的列 type:retirement 分开）。
 */
function outflow(exits: readonly MovementExit[], sequences: readonly DictionaryItem[], dictionaries: ExitDictionaries) {
  const reasonKey = (e: MovementExit) => JSON.stringify([...exitType(e).parts, exitReason(e).code]);
  const reasonRows = [...new Map(exits.map((e) => [reasonKey(e), e])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => ({
      key,
      label: `${exitType(e).label} / ${exitReason(e).label}`,
      group: unique(exits.filter((item) => reasonKey(item) === key)),
    }));
  const leaveType = (e: MovementExit) =>
    e.kind === 'leave' && e.typeCode
      ? { code: e.typeCode, label: e.typeName ?? e.typeCode }
      : { code: null, label: '' };
  const types = codeColumns(exits, dictionaries.types, leaveType);
  const reasons = codeColumns(exits, dictionaries.reasons, exitReason);
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
    ...types.columns.map(({ code, name }) => count<MovementExit>(`type:${code}`, name, (e) => types.keyOf(e) === code)),
    count<MovementExit>(MOVEMENT_RETIREMENT_TYPE.code, MOVEMENT_RETIREMENT_TYPE.name, (e) => e.kind === 'retirement'),
    ...reasons.columns.map(({ code, name }) =>
      count<MovementExit>(`reason:${code}`, name, (e) => reasons.keyOf(e) === code),
    ),
    count<MovementExit>('keyPerson', '关键人员', (e) => e.keyPerson),
  ];
  return [
    table(
      'reasons',
      '离职类型与原因',
      [{ key: 'count', label: '人数', value: (items) => items.length }],
      reasonRows,
      unique(exits),
    ),
    table('sequences', '离职人员属性', columns, sequenceRows(exits, sequences), unique(exits)),
  ];
}

/**
 * 组织编制统计：每个编制对象一行，编制与实有人员都取 day（年底与 asOf 较早者）；合计只汇总本级编制（含下级编制与
 * 实有人员逐级包含，相加会重复计数）。
 */
function establishmentTable(x: ReportLookup, day: string) {
  interface Cell {
    readonly local: number | null;
    readonly inclusive: number | null;
    readonly actual: number | null;
  }
  const missing = (key: string, label: string): Column<Cell> => ({ key, label, value: () => null });
  const columns: Column<Cell>[] = [
    { key: 'localCapacity', label: '本级编制', value: (c) => c.local },
    { key: 'inclusiveCapacity', label: '含下级编制', value: (c) => c.inclusive },
    { key: 'actual', label: '实有人员（含下级）', value: (c) => c.actual },
    // 预增员 / 预减员按组织汇总的读接口尚未抽出（F-418），缺编数与执行率依赖它们，整列 null
    missing('pendingIn', '预增员'),
    missing('pendingOut', '预减员'),
    missing('vacancy', '缺编数'),
    missing('executionRate', '执行率'),
  ];
  const rows = x.establishment
    .map((e) => ({
      key: e.id,
      label: x.tree.name(e.orgId),
      group: {
        local: e.localCapacity,
        inclusive: e.inclusiveCapacity,
        actual: actualStaff(x.data, day, x.tree, e.orgId).length,
      },
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh') || a.key.localeCompare(b.key));
  const local = x.establishment.reduce((sum, e) => sum + (e.localCapacity ?? 0), 0);
  return [table('establishment', '组织编制统计', columns, rows, { local, inclusive: null, actual: null })];
}

/** 各月页签的合计：计数列 = 各已到月份行之和（asOf 之后的月份为 null，不计），离职率按合计重算（审查 P2-5）。 */
function monthlyTotal(rows: readonly Row<Slice>[]) {
  const months = rows.flatMap((row) => (row.group ? [row.group] : []));
  const sum = (part: keyof Slice) => months.reduce((total, month) => total + month[part].length, 0);
  const totals = { opening: sum('opening'), hires: sum('hires'), exits: sum('exits'), closing: sum('closing') };
  return { ...totals, rate: leaveRate(totals.exits, totals.opening, totals.closing) };
}

export interface ReportLookup {
  readonly tree: OrgTree;
  readonly data: MovementData;
  readonly sequences: readonly DictionaryItem[];
  readonly exitDictionaries: ExitDictionaries;
  /** 年度取数日的组织编制（已按部门筛选裁剪），只有组织编制页签用。 */
  readonly establishment: readonly MovementEstablishment[];
  /** 流动统计按组织层级下钻：给出时行 = 该组织的直接下级（人员直接挂在它上面时归它自己）。 */
  readonly parentId?: string;
}

/** 一个页签的表格。 */
export function movementReport(code: HrMovementReportCode, period: ReportPeriod, x: ReportLookup) {
  const { span } = reportWindow(code, period);
  const raw = rawSlice(x.data, span, x.data.window);
  const whole = dedupe(raw);
  switch (code) {
    case 'flow': {
      const rowOf = (departmentId: string | null) => {
        if (!x.parentId) return x.tree.level1(departmentId);
        const chain = x.tree.chain(departmentId);
        const at = chain.indexOf(x.parentId);
        return at < 0 ? null : (chain[Math.max(at - 1, 0)] ?? null);
      };
      const rows = sliceBy(raw, rowOf);
      // 合计只算进了某一行的记录（下钻时 parentId 以外的不算）；不下钻时每条都进一级组织行，即全部
      const all = sliceBy(raw, (d) => (rowOf(d) === null ? null : 'all')).get('all') ?? EMPTY_SLICE;
      return [table('flow', '员工流动统计', flowColumns, orgRows(rows, x.tree), all)];
    }
    case 'monthly': {
      const months = yearMonths(period.year, period.asOf);
      const rows = months.map((m, index) => {
        const key = `${String(period.year).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}`;
        return { key, label: key, group: m ? dedupe(rawSlice(x.data, m, x.data)) : null };
      });
      const result = table('monthly', '各月入离职统计', monthColumns, rows, EMPTY_SLICE);
      return [{ ...result, summary: { cells: monthlyTotal(rows) } }];
    }
    case 'institution': {
      // 一级机构 = 行政树根下的直属组织（不论组织类型，F-431①）
      const rows = orgRows(sliceBy(raw, x.tree.level1), x.tree);
      return [table('institution', '各机构入离职统计', monthColumns, rows, whole)];
    }
    case 'inflow':
      return inflow(raw.hires, x.sequences, period.asOf);
    case 'outflow':
      return outflow(raw.exits, x.sequences, x.exitDictionaries);
    case 'establishment':
      return establishmentTable(x, span.end);
  }
}
