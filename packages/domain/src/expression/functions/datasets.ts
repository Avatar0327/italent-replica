/**
 * F-033 新增的三个取数函数（`26` §8.6 面板业务函数；DEC-260）。本任务只定端口签名、注册面板中文名，
 * 数据源未接入时返回结构化的“计算失败”（DATA_UNAVAILABLE）；真实数据源与按查看人裁剪由使用方接线：
 * 人才评定 → R3-T02，人事子集 / 参数规则 → 后续任务（同 Lastest360Cent 交 R3-T03 的做法）。
 * 英文名为复刻命名：R3e 核实原站面板与说明只显示中文名，英文名未验证（`26` 末节）。
 */
import type { ExprNode, FieldNode } from '../ast.js';
import { compare } from '../operators.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { TalentReviewRecord } from '../ports.js';
import { EMPTY, type ExprValue } from '../values.js';
import { matchesAll, recordReader, requireFieldOf, unwrapPort } from './shared.js';

export const TALENT_REVIEW_OBJECT = '人才评定';
const TALENT_REVIEW_PREFIXES = [TALENT_REVIEW_OBJECT] as const;

const passedLatestFirst = (a: TalentReviewRecord, b: TalentReviewRecord) => b.passedAt.getTime() - a.passedAt.getTime();

/**
 * 最近一次已通过的评定（DEC-260）。R3e 已核实（`26` 末节，W-864 说明原文）：取“最近一次已通过的评定活动中的得分”，
 * “已通过”指评定活动通过（端口的 passed），不是认证结果。TODO(需取证 #105)：是否受盘点项目时间限制仍未验证，暂不限制。
 */
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

const SORT_ORDERS: Readonly<Record<string, 'asc' | 'desc'>> = { 升序: 'asc', 降序: 'desc' };

/** 必须是 子集.字段 的字段引用。 */
function subsetField(call: FunctionCall, node: ExprNode | undefined, label: string): FieldNode {
  if (node?.type === 'field' && node.path.length === 2) return node;
  return call.fail('ARGUMENT_TYPE', `${label}须是 子集.字段 的字段引用`);
}

/**
 * 人事子集指定字段（R3e 已核实，`26` 末节 W-864 说明原文）：参数为 指定字段、排序字段、升 / 降序、可选条件，
 * 返回排序后的第一条，不要求唯一行。排序字段为空的行排在最后；排序值相同保持数据源顺序。
 * 排序按比较运算的口径（数值、日期、日期格式的文本可以比较大小，其他文本比较大小计算失败，DEC-257）。
 */
function personnelSubsetField(call: FunctionCall): ExprValue {
  const [first, second, direction, ...filters] = call.rawArgs;
  const target = subsetField(call, first, '第一个参数');
  const sortBy = subsetField(call, second, '排序字段');
  const subset = target.path[0]!;
  if (sortBy.path[0] !== subset) return call.fail('ARGUMENT_TYPE', `排序字段须是子集 ${subset} 的字段`);
  const order = direction ? call.evaluate(direction) : EMPTY;
  const sort = order.kind === 'text' ? SORT_ORDERS[order.value.trim()] : undefined;
  if (!sort) return call.fail('ARGUMENT_TYPE', '第三个参数须是 "升序" 或 "降序"');
  const rows = unwrapPort(call, 'personnelSubset', () =>
    call.env.ports?.personnelSubset?.records(call.env.subjectId, subset),
  );
  const read = recordReader(call, [subset], call.rawArgs);
  const ahead = sort === 'asc' ? '<' : '>';
  /** 排在前面：非空先于空；都非空时按方向严格领先（相同保持数据源顺序）。 */
  const before = (key: ExprValue, current: ExprValue) => {
    if (key.kind === 'empty') return false;
    return current.kind === 'empty' || compare(ahead, key, current, call.env.semantics);
  };
  let best: { readonly record: Readonly<Record<string, ExprValue>>; readonly key: ExprValue } | undefined;
  for (const record of rows.map((row) => read(row.fields))) {
    if (!matchesAll(call, filters, record)) continue;
    const key = call.evaluate(sortBy, record);
    if (!best || before(key, best.key)) best = { record, key };
  }
  return best ? call.evaluate(target, best.record) : EMPTY;
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
      { name: '排序字段', required: true },
      { name: '升序 / 降序', required: true },
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
