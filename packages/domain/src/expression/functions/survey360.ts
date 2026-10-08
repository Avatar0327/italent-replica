/**
 * 360 取数（`26` §3.5 TR-R28、§8.6）：Lastest360Cent(分数字段, 过滤表达式…)。
 * 🟡 DEC-262②：“最近一次”只取已结束且报告已生成的活动（结束时间不晚于盘点项目结束时间），按结束时间倒序、
 * 结束时间相同按报告生成时间倒序；进行中活动不计。DEC-031 的窗口参数只作用于测评。真实数据源与按查看人裁剪在 R3-T03。
 */
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { Survey360Record } from '../ports.js';
import { EMPTY, type ExprValue } from '../values.js';
import { latestBoundary, matchesAll, recordReader, requireFieldOf, unwrapPort, withinBoundary } from './shared.js';

export const SURVEY360_OBJECT = '360结果';
const PREFIXES = [SURVEY360_OBJECT] as const;

type Finished = Survey360Record & { readonly endAt: Date; readonly reportGeneratedAt: Date };

const isFinished = (row: Survey360Record): row is Finished =>
  row.endAt !== undefined && row.reportGeneratedAt !== undefined;

const activityKey = (row: Finished) => row.activityId ?? `${row.endAt.getTime()}|${row.reportGeneratedAt.getTime()}`;

const latestFirst = (a: Finished, b: Finished) =>
  b.endAt.getTime() - a.endAt.getTime() || b.reportGeneratedAt.getTime() - a.reportGeneratedAt.getTime();

function latest360(call: FunctionCall): ExprValue {
  const scoreField = requireFieldOf(call, call.rawArgs[0], PREFIXES, '分数字段');
  const filters = call.rawArgs.slice(1);
  const rows = unwrapPort(call, 'survey360', () => call.env.ports?.survey360?.records(call.env.subjectId));
  const boundary = latestBoundary(call, 'survey360');
  const read = recordReader(call, PREFIXES, call.rawArgs);
  const candidates = rows
    .filter(isFinished)
    .filter((row) => withinBoundary(row.endAt, boundary))
    .map((row) => ({ row, record: read(row.fields) }))
    .filter(({ record }) => matchesAll(call, filters, record))
    .sort((a, b) => latestFirst(a.row, b.row));
  const latest = candidates[0];
  if (!latest) return EMPTY;
  // 同一活动的多行（角色 / 维度 / 题目）里取第一个有值的分数
  for (const { row, record } of candidates) {
    if (activityKey(row) !== activityKey(latest.row)) continue;
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
    recordObjects: PREFIXES,
    returns: 'number',
    implement: latest360,
  },
];
