/**
 * F-033 新增的三个取数函数（`26` §8.6 面板业务函数；DEC-260）。本任务只定端口签名、注册面板中文名，
 * 数据源未接入时返回结构化的“计算失败”（DATA_UNAVAILABLE）；真实数据源与按查看人裁剪由使用方接线：
 * 人才评定 → R3-T02，人事子集 / 参数规则 → 后续任务（同 Lastest360Cent 交 R3-T03 的做法）。
 * 英文名为复刻命名（面板只有中文名）。
 */
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { TalentReviewRecord } from '../ports.js';
import { EMPTY, type ExprValue } from '../values.js';
import { matchesAll, recordReader, requireFieldOf, unwrapPort } from './shared.js';

export const TALENT_REVIEW_OBJECT = '人才评定';
const TALENT_REVIEW_PREFIXES = [TALENT_REVIEW_OBJECT] as const;

const passedLatestFirst = (a: TalentReviewRecord, b: TalentReviewRecord) => b.passedAt.getTime() - a.passedAt.getTime();

/** 最近一次已通过的评定（DEC-260）；TODO(需取证 #105)：“已通过”的含义与是否受盘点项目时间限制。 */
function latestTalentReview(call: FunctionCall): ExprValue {
  const field = requireFieldOf(call, call.rawArgs[0], TALENT_REVIEW_PREFIXES, '结果字段');
  const filters = call.rawArgs.slice(1);
  const rows = unwrapPort(call, 'talentReview', () => call.env.ports?.talentReview?.records(call.env.subjectId));
  const read = recordReader(call, TALENT_REVIEW_PREFIXES, call.rawArgs);
  const latest = rows
    .filter((row) => row.passed)
    .sort(passedLatestFirst)
    .map((row) => read(row.fields))
    .find((record) => matchesAll(call, filters, record));
  return latest ? call.evaluate(field, latest) : EMPTY;
}

/**
 * 人事子集指定字段：第一个参数 子集.字段，其余为过滤条件；须取到唯一一行（`26` §8.6），多行计算失败。
 * TODO(需取证 #105)：面板四个参数位的确切含义。
 */
function personnelSubsetField(call: FunctionCall): ExprValue {
  const first = call.rawArgs[0];
  if (first?.type !== 'field' || first.path.length !== 2) {
    return call.fail('ARGUMENT_TYPE', '第一个参数须是 子集.字段 的字段引用');
  }
  const subset = first.path[0]!;
  const filters = call.rawArgs.slice(1);
  const rows = unwrapPort(call, 'personnelSubset', () =>
    call.env.ports?.personnelSubset?.records(call.env.subjectId, subset),
  );
  const read = recordReader(call, [subset], call.rawArgs);
  const matched = rows.map((row) => read(row.fields)).filter((record) => matchesAll(call, filters, record));
  if (matched.length > 1)
    return call.fail('AMBIGUOUS_DATA', `人事子集 ${subset} 取到 ${matched.length} 条，须取到唯一值`);
  return matched[0] ? call.evaluate(first, matched[0]) : EMPTY;
}

/** 按照参数规则获取数据：TODO(需取证 #105) 参数含义与规则配置位置；参数求值后原样交给端口。 */
function parameterRuleData(call: FunctionCall): ExprValue {
  const value = unwrapPort(call, 'parameterRule', () =>
    call.env.ports?.parameterRule?.value(call.env.subjectId, call.args),
  );
  return call.env.fromPlain(value);
}

export const DATASET_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'LastestTalentReview',
    aliases: ['获取最近一次人才评定数据'],
    params: [
      { name: '结果字段', required: true },
      { name: '过滤表达式', required: false, variadic: true },
    ],
    lazy: true,
    recordObjects: TALENT_REVIEW_PREFIXES,
    implement: latestTalentReview,
  },
  {
    name: 'PersonnelSubsetField',
    aliases: ['获取人事子集的指定字段数据'],
    params: [
      { name: '子集字段', required: true },
      { name: '过滤表达式', required: false, variadic: true },
    ],
    lazy: true,
    implement: personnelSubsetField,
  },
  {
    name: 'ParameterRuleData',
    aliases: ['按照参数规则获取数据'],
    params: [{ name: '参数', required: false, variadic: true }],
    implement: parameterRuleData,
  },
];
