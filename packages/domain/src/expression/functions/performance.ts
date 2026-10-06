/**
 * 绩效取数（`26` §3.5 TR-R28、§8.1）：数据来自人员子集「考核结果」，经 PerformancePort 注入。
 * PerformanceCent / Grade：年度、周期两个过滤表达式必填，其他过滤选填；同年同周期多条取最后修改的。
 * PerformanceLastCent / Grade(N)：最近第 N 年，不要求连续年份，无结果返回空而非 0（🟡 手册未再出现，维持 `26` §3.5 口径；
 * 周期与中文名 TODO(需取证 #89)）。
 */
import { instantToParts } from '../dates.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { PerformanceRecord } from '../ports.js';
import { EMPTY, type ExprValue } from '../values.js';
import { matchesAll, prefixedFields, unwrapPort } from './shared.js';

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
  return unwrapPort(call, 'performance', call.env.ports?.performance?.records(call.env.subjectId));
}

function lastModified(rows: readonly PerformanceRecord[]): PerformanceRecord | undefined {
  return rows.reduce<PerformanceRecord | undefined>(
    (latest, row) => (latest === undefined || row.modifiedAt.getTime() > latest.modifiedAt.getTime() ? row : latest),
    undefined,
  );
}

function resultField(call: FunctionCall, row: PerformanceRecord | undefined, field: string): ExprValue {
  return row ? call.env.fromPlain(row.fields[field]) : EMPTY;
}

/** 按过滤表达式筛行（年度、周期、其他过滤都在记录作用域里求值）。 */
function byFilters(call: FunctionCall, field: string): ExprValue {
  const matched = records(call).filter((row) =>
    matchesAll(call, call.rawArgs, prefixedFields(call, PREFIXES, row.fields)),
  );
  return resultField(call, lastModified(matched), field);
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

function byRecency(call: FunctionCall, field: string): ExprValue {
  const n = Math.trunc(call.numberArg(call.args, 0));
  if (n < 1) return call.fail('ARGUMENT_TYPE', 'N 须是不小于 1 的整数');
  const limit = referenceYear(call);
  const years = [
    ...new Set(
      records(call)
        .map(yearOf)
        .filter((year): year is number => year !== undefined && year <= limit),
    ),
  ];
  const target = years.sort((a, b) => b - a)[n - 1];
  if (target === undefined) return EMPTY;
  return resultField(call, lastModified(records(call).filter((row) => yearOf(row) === target)), field);
}

const FILTER_PARAMS = [
  filterParam('年度表达式', true),
  filterParam('周期表达式', true),
  filterParam('其他过滤', false, true),
];

export const PERFORMANCE_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'PerformanceCent',
    aliases: ['获取指定年度指定周期的绩效得分'],
    params: FILTER_PARAMS,
    lazy: true,
    implement: (call) => byFilters(call, PERFORMANCE_FIELDS.score),
  },
  {
    name: 'PerformanceGrade',
    aliases: ['获取指定年度指定周期的绩效等级'],
    params: FILTER_PARAMS,
    lazy: true,
    implement: (call) => byFilters(call, PERFORMANCE_FIELDS.grade),
  },
  {
    // TODO(需取证 #89)：中文名为推断（手册未列出）；同年多周期取哪条、结束年当年是否算第 1 年待核对
    name: 'PerformanceLastCent',
    aliases: ['获取最近第N年度的绩效得分'],
    params: [filterParam('N', true)],
    implement: (call) => byRecency(call, PERFORMANCE_FIELDS.score),
  },
  {
    name: 'PerformanceLastGrade',
    aliases: ['获取最近第N年度的绩效等级'],
    params: [filterParam('N', true)],
    implement: (call) => byRecency(call, PERFORMANCE_FIELDS.grade),
  },
];
