/**
 * 测评取数（DEC-031 / DEC-210）：LastestAssessmentCent(测验信息.总分 | 维度得分, 过滤表达式…)，过滤至少一个。
 * 数据来自人员子集「测验结果」；“最近一次”的时间口径为计算参数（默认盘点项目结束时间前，可改为开始时间前）。
 */
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type ExprValue } from '../values.js';
import { latestBoundary, matchesAll, recordReader, requireFieldOf, unwrapPort, withinBoundary } from './shared.js';

/** 手册写法是 测验信息.*，子集名是「测验结果」（DEC-031）：两种前缀都接受。 */
export const ASSESSMENT_OBJECTS = ['测验信息', '测验结果'] as const;

function latestAssessment(call: FunctionCall): ExprValue {
  const scoreField = requireFieldOf(call, call.rawArgs[0], ASSESSMENT_OBJECTS, '分数字段');
  const filters = call.rawArgs.slice(1);
  const rows = unwrapPort(call, 'assessment', () => call.env.ports?.assessment?.records(call.env.subjectId));
  const boundary = latestBoundary(call, 'assessment');
  const read = recordReader(call, ASSESSMENT_OBJECTS, call.rawArgs);
  const candidates = rows
    .map((row) => ({ row, record: read(row.fields) }))
    .filter(({ row, record }) => withinBoundary(row.testedAt, boundary) && matchesAll(call, filters, record))
    .sort((a, b) => b.row.testedAt.getTime() - a.row.testedAt.getTime());
  const latest = candidates[0];
  return latest ? call.evaluate(scoreField, latest.record) : EMPTY;
}

export const ASSESSMENT_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'LastestAssessmentCent',
    // 面板名（§8.6，名字里的“/”由词法单独识别）；“获取最近一次的测评总分”是手册写法
    aliases: ['获取当前人员测评测验下的最近一次测评得分/维度得分', '获取最近一次的测评总分', 'LatestAssessmentCent'],
    params: [
      { name: '分数字段', required: true },
      { name: '过滤表达式', required: true, variadic: true },
    ],
    lazy: true,
    recordObjects: ASSESSMENT_OBJECTS,
    implement: latestAssessment,
  },
];
