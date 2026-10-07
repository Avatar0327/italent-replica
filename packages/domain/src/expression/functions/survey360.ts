/**
 * 360 取数（`26` §3.5 TR-R28、§8.1）：Lastest360Cent(分数字段, 过滤表达式…)。
 * “最近一次” = 盘点项目结束时间前最近开始的 360 活动（TR-R28，固定口径；DEC-031 的窗口参数只作用于测评）。
 */
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { Survey360Record } from '../ports.js';
import { EMPTY, type ExprValue } from '../values.js';
import { latestBoundary, matchesAll, prefixedFields, requireFieldOf, unwrapPort, withinBoundary } from './shared.js';

export const SURVEY360_OBJECT = '360结果';
const PREFIXES = [SURVEY360_OBJECT] as const;

function latest360(call: FunctionCall): ExprValue {
  const scoreField = requireFieldOf(call, call.rawArgs[0], PREFIXES, '分数字段');
  const filters = call.rawArgs.slice(1);
  const rows = unwrapPort(call, 'survey360', () => call.env.ports?.survey360?.records(call.env.subjectId));
  const boundary = latestBoundary(call, 'survey360');
  const candidates = rows
    .map((row) => ({ row, record: prefixedFields(call, PREFIXES, row.fields) }))
    .filter(({ row, record }) => withinBoundary(row.startAt, boundary) && matchesAll(call, filters, record));
  const latestStart = candidates.reduce<number | undefined>(
    (max, { row }) => (max === undefined || row.startAt.getTime() > max ? row.startAt.getTime() : max),
    undefined,
  );
  if (latestStart === undefined) return EMPTY;
  const sameActivity = (row: Survey360Record) => row.startAt.getTime() === latestStart;
  for (const { row, record } of candidates) {
    if (!sameActivity(row)) continue;
    const score = call.evaluate(scoreField, record);
    if (score.kind !== 'empty') return score;
  }
  return EMPTY;
}

export const SURVEY360_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Lastest360Cent',
    aliases: ['获取最近一次360总分', 'Latest360Cent'],
    params: [
      { name: '分数字段', required: true },
      { name: '过滤表达式', required: false, variadic: true },
    ],
    lazy: true,
    implement: latest360,
  },
];
