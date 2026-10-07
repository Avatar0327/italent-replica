/**
 * 绩效取数（`26` §3.5 TR-R28、§8.6；DEC-260）：数据来自人员子集「考核结果」，经 PerformancePort 注入。
 * 周期按周期名称文本过滤（考核结果.周期名称="年度" / "第三季度"），可选绩效活动等其他过滤。
 * - 指定年度指定周期的得分 / 等级：年度、周期两个过滤必填，其他过滤选填；同年同周期多条取最后修改的。
 * - 最近第 N 年的得分 / 等级：过滤后按年度倒序取第 N 个年度（不要求连续年份，不晚于参考年），无结果返回空。
 * - 最近第 N 次的得分 / 等级：过滤后按“考核结果相关日期”倒序取第 N 条。
 * TODO(需取证 #105)：第 N 年 / 第 N 次的参数顺序与日期字段是否为参数原站未说明，暂按参数形态识别（见 recencyArgs）。
 */
import type { ExprNode, FieldNode } from '../ast.js';
import { dateOrdinal, instantToParts } from '../dates.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { PerformanceRecord } from '../ports.js';
import { EMPTY, type ExprValue } from '../values.js';
import { matchesAll, recordReader, unwrapPort } from './shared.js';

/** 「考核结果」子集的字段名（`22`）。 */
export const PERFORMANCE_FIELDS = {
  object: '考核结果',
  year: '年度',
  period: '周期名称',
  score: '得分',
  grade: '等级',
} as const;

const PREFIXES = [PERFORMANCE_FIELDS.object] as const;
const filterParam = (name: string, required: boolean, variadic = false) => ({ name, required, variadic });

function records(call: FunctionCall): readonly PerformanceRecord[] {
  return unwrapPort(call, 'performance', () => call.env.ports?.performance?.records(call.env.subjectId));
}

const newestFirst = (a: PerformanceRecord, b: PerformanceRecord) => b.modifiedAt.getTime() - a.modifiedAt.getTime();

function resultField(call: FunctionCall, row: PerformanceRecord | undefined, field: string): ExprValue {
  return row ? call.env.fromPlain(row.fields[field]) : EMPTY;
}

/** 过滤后的行（过滤表达式在记录作用域里求值）。 */
function filtered(call: FunctionCall, filters: readonly ExprNode[], extra: readonly ExprNode[] = []) {
  const read = recordReader(call, PREFIXES, [...filters, ...extra]);
  return records(call)
    .map((row) => ({ row, record: read(row.fields) }))
    .filter(({ record }) => matchesAll(call, filters, record));
}

function byFilters(call: FunctionCall, field: string): ExprValue {
  const rows = filtered(call, call.rawArgs).map(({ row }) => row);
  return resultField(call, [...rows].sort(newestFirst)[0], field);
}

interface RecencyArgs {
  readonly n: number;
  readonly filters: readonly ExprNode[];
  readonly dateField?: FieldNode;
}

const isFilterShaped = (node: ExprNode) =>
  node.type === 'logical' ||
  node.type === 'boolean' ||
  (node.type === 'binary' && !['+', '-', '*', '/'].includes(node.operator));

/**
 * 按参数形态识别：比较 / 且或 / 是否值是过滤条件；考核结果的字段引用（第 N 次时第一个）是排序用的日期字段；
 * 其余（数字、变量、算式）是 N，必须恰好一个。
 */
function recencyArgs(call: FunctionCall, withDateField: boolean): RecencyArgs {
  const filters: ExprNode[] = [];
  const counts: ExprNode[] = [];
  let dateField: FieldNode | undefined;
  for (const node of call.rawArgs) {
    if (withDateField && !dateField && node.type === 'field' && node.path[0] === PERFORMANCE_FIELDS.object) {
      dateField = node;
    } else if (isFilterShaped(node) || node.type === 'field') {
      filters.push(node);
    } else {
      counts.push(node);
    }
  }
  if (counts.length !== 1) return call.fail('ARGUMENT_TYPE', 'N 须写且只写一个（不小于 1 的整数）');
  const n = Math.trunc(call.numberArg([call.evaluate(counts[0]!)], 0));
  if (n < 1) return call.fail('ARGUMENT_TYPE', 'N 须是不小于 1 的整数');
  return dateField ? { n, filters, dateField } : { n, filters };
}

function yearOf(row: PerformanceRecord): number | undefined {
  const raw = row.fields[PERFORMANCE_FIELDS.year];
  const year = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isInteger(year) ? year : undefined;
}

/** 参考年：盘点项目结束时间所在年（按租户时区），没有项目时间则用“今天”所在年。 */
function referenceYear(call: FunctionCall): number {
  const endAt = call.env.project?.endAt;
  if (endAt) return instantToParts(endAt, call.env.calendar.timeZone).year;
  return Number(call.env.calendar.today.slice(0, 4));
}

function byRecentYear(call: FunctionCall, field: string): ExprValue {
  const { n, filters } = recencyArgs(call, false);
  const rows = filtered(call, filters).map(({ row }) => row);
  const limit = referenceYear(call);
  const years = [...new Set(rows.map(yearOf).filter((year): year is number => year !== undefined && year <= limit))];
  const target = years.sort((a, b) => b - a)[n - 1];
  if (target === undefined) return EMPTY;
  return resultField(call, rows.filter((row) => yearOf(row) === target).sort(newestFirst)[0], field);
}

/** 第 N 次：按日期字段倒序（日期为空的行不参与）；没写日期字段时按最后修改时间（🟡 #105）。 */
function byRecentOccurrence(call: FunctionCall, field: string): ExprValue {
  const { n, filters, dateField } = recencyArgs(call, true);
  const sortKey = (row: PerformanceRecord, record: Readonly<Record<string, ExprValue>>): number | undefined => {
    if (!dateField) return row.modifiedAt.getTime();
    const value = call.evaluate(dateField, record);
    return value.kind === 'empty' ? undefined : dateOrdinal(call.toDate(value));
  };
  const ranked = filtered(call, filters, dateField ? [dateField] : [])
    .map(({ row, record }) => ({ row, key: sortKey(row, record) }))
    .filter((entry): entry is { row: PerformanceRecord; key: number } => entry.key !== undefined)
    .sort((a, b) => b.key - a.key || newestFirst(a.row, b.row));
  return resultField(call, ranked[n - 1]?.row, field);
}

const FILTER_PARAMS = [
  filterParam('年度表达式', true),
  filterParam('周期表达式', true),
  filterParam('其他过滤', false, true),
];
const RECENT_YEAR_PARAMS = [filterParam('N', true), filterParam('周期表达式 / 其他过滤', false, true)];
const RECENT_OCCURRENCE_PARAMS = [
  filterParam('N', true),
  filterParam('周期表达式', true),
  filterParam('考核结果日期字段 / 其他过滤', false, true),
];

/** 得分函数返回数值、等级函数返回文本（保存检查用，DEC-270）。 */
const fetchSpec = (
  name: string,
  aliases: string[],
  params: FunctionSpec['params'],
  field: string,
  pick: (call: FunctionCall, field: string) => ExprValue,
): FunctionSpec => ({
  name,
  aliases,
  params,
  lazy: true,
  recordObjects: PREFIXES,
  returns: field === PERFORMANCE_FIELDS.score ? 'number' : 'text',
  implement: (call) => pick(call, field),
});

export const PERFORMANCE_FUNCTIONS: readonly FunctionSpec[] = [
  fetchSpec('PerformanceCent', ['获取指定年度指定周期的绩效得分'], FILTER_PARAMS, PERFORMANCE_FIELDS.score, byFilters),
  fetchSpec('PerformanceGrade', ['获取指定年度指定周期的绩效等级'], FILTER_PARAMS, PERFORMANCE_FIELDS.grade, byFilters),
  // 面板名（§8.6）；“获取最近第N年度的…”是 R3-T00 时的推断名，保留兼容
  fetchSpec(
    'PerformanceLastCent',
    ['获取最近第N年的绩效考核得分', '获取最近第N年度的绩效得分'],
    RECENT_YEAR_PARAMS,
    PERFORMANCE_FIELDS.score,
    byRecentYear,
  ),
  fetchSpec(
    'PerformanceLastGrade',
    ['获取最近第N年的绩效考核等级', '获取最近第N年度的绩效等级'],
    RECENT_YEAR_PARAMS,
    PERFORMANCE_FIELDS.grade,
    byRecentYear,
  ),
  // 英文名为复刻命名（面板只有中文名）
  fetchSpec(
    'PerformanceNthCent',
    ['获取最近第N次绩效考核得分'],
    RECENT_OCCURRENCE_PARAMS,
    PERFORMANCE_FIELDS.score,
    byRecentOccurrence,
  ),
  fetchSpec(
    'PerformanceNthGrade',
    ['获取最近第N次绩效考核等级'],
    RECENT_OCCURRENCE_PARAMS,
    PERFORMANCE_FIELDS.grade,
    byRecentOccurrence,
  ),
];
