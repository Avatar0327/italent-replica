/**
 * 排名（`26` §3.5 TR-R28、§8.1）：Ranking(模式, 排序字段, 人员范围条件?, 分组字段?)。
 * 模式 "排序号"：降序名次，并列同名次（1-2-2-4）；"百分位"：不高于本人的人数占比，按小数返回（🟡 TODO(需取证 #89)：百分位定义与并列名次）。
 * 范围 = RankingPort 给出的人员（批量求值时默认本次计算对象）再按范围条件筛选；本人不在范围内 → 范围外人员（207126957 问题 2）。
 */
import type { ExprNode } from '../ast.js';
import { valuesEqual } from '../operators.js';
import type { SubjectReader } from '../ports.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type ExprValue } from '../values.js';
import { unwrapPort } from './shared.js';

const MODES: Readonly<Record<string, 'rank' | 'percentile'>> = {
  排序号: 'rank',
  排名: 'rank',
  rank: 'rank',
  百分位: 'percentile',
  percentile: 'percentile',
};

interface Member {
  readonly subject: SubjectReader;
  readonly value: number;
  readonly group: ExprValue;
}

function tryEvaluate(call: FunctionCall, node: ExprNode | undefined, subject: SubjectReader): ExprValue | undefined {
  if (!node) return undefined;
  try {
    return call.evaluateForSubject(node, subject);
  } catch {
    return undefined;
  }
}

/** 范围内成员：范围条件为真且排序字段是数值；求值失败的成员不参与排名。 */
function collectMembers(call: FunctionCall, population: readonly SubjectReader[]): Member[] {
  const [, sortField, rangeCondition, groupField] = call.rawArgs;
  const members: Member[] = [];
  for (const subject of population) {
    const inRange = rangeCondition ? tryEvaluate(call, rangeCondition, subject) : { kind: 'boolean', value: true };
    if (!inRange || inRange.kind !== 'boolean' || !inRange.value) continue;
    const sortValue = tryEvaluate(call, sortField, subject);
    const value =
      sortValue?.kind === 'number'
        ? sortValue.value
        : sortValue?.kind === 'option'
          ? Number(sortValue.value)
          : Number.NaN;
    if (!Number.isFinite(value)) continue;
    members.push({ subject, value, group: tryEvaluate(call, groupField, subject) ?? EMPTY });
  }
  return members;
}

function ranking(call: FunctionCall): ExprValue {
  const mode =
    MODES[
      call
        .textArg([call.evaluate(call.rawArgs[0]!)], 0)
        .trim()
        .toLowerCase()
    ];
  if (!mode) return call.fail('ARGUMENT_TYPE', '排名模式须是 "百分位" 或 "排序号"');
  if (call.rawArgs[1]?.type !== 'field' && call.rawArgs[1]?.type !== 'identifier') {
    return call.fail('ARGUMENT_TYPE', '排序字段须是字段引用');
  }
  const population = unwrapPort(call, 'ranking', () => call.env.ports?.ranking?.population());
  const self = population.find((subject) => subject.id === call.env.subjectId);
  if (!self) return call.fail('OUT_OF_SCOPE', '本人不在本次计算的人员范围内');
  const members = collectMembers(call, population);
  const me = members.find((member) => member.subject.id === self.id);
  if (!me) {
    const sortValue = tryEvaluate(call, call.rawArgs[1], self);
    if (sortValue?.kind === 'empty') return call.fail('EMPTY_IN_COMPARISON', '排序字段为空，无法排名');
    return call.fail('OUT_OF_SCOPE', '本人不满足人员范围条件');
  }
  const peers = members.filter((member) => valuesEqual(member.group, me.group, call.env.semantics));
  if (mode === 'rank') return { kind: 'number', value: peers.filter((member) => member.value > me.value).length + 1 };
  return { kind: 'number', value: peers.filter((member) => member.value <= me.value).length / peers.length };
}

export const RANKING_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Ranking',
    aliases: ['获取某个结果在指定人员范围内的排名', '排名'],
    params: [
      { name: '模式', required: true, description: '"百分位" 或 "排序号"' },
      { name: '排序字段', required: true },
      { name: '人员范围条件', required: false },
      { name: '分组字段', required: false },
    ],
    lazy: true,
    implement: ranking,
  },
];
