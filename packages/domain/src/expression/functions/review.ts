/**
 * 盘点与评定专用函数（REQ-EXP-001、`24` EV-R8）：取模块分或结果、统计指定结果的模块数、指定模块所有评委平均分、
 * 统计指定得分或结果的评委数、所有评委平均分；弃权评委不参与。英文名为复刻命名（🟡 TODO(需取证 #89)）。
 */
import { valuesEqual } from '../operators.js';
import type { ReviewJudge, ReviewModule } from '../ports.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type ExprValue } from '../values.js';
import { average, unwrapPort } from './shared.js';

const param = (name: string, required = true) => ({ name, required });

function modules(call: FunctionCall): readonly ReviewModule[] {
  return unwrapPort(call, 'review', call.env.ports?.review?.modules(call.env.subjectId));
}

function moduleNamed(call: FunctionCall, index: number): ReviewModule | undefined {
  const name = call.textArg(call.args, index);
  return modules(call).find((module) => module.name === name);
}

const activeJudges = (module: ReviewModule): readonly ReviewJudge[] =>
  module.judges.filter((judge) => !judge.abstained);
const scores = (judges: readonly ReviewJudge[]): number[] =>
  judges
    .map((judge) => judge.score)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));

function judgeMatches(call: FunctionCall, judge: ReviewJudge, wanted: ExprValue): boolean {
  const score = call.env.fromPlain(judge.score);
  const result = call.env.fromPlain(judge.result);
  const semantics = call.env.semantics;
  return (
    (score.kind !== 'empty' && valuesEqual(score, wanted, semantics)) ||
    (result.kind !== 'empty' && valuesEqual(result, wanted, semantics))
  );
}

export const REVIEW_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'ModuleResult',
    aliases: ['取模块分或结果'],
    params: [param('模块名'), param('类型', false)],
    description: '类型 "得分"（默认）或 "结果"',
    implement: (call) => {
      const module = moduleNamed(call, 0);
      const kind = call.args.length > 1 ? call.textArg(call.args, 1) : '得分';
      if (kind !== '得分' && kind !== '结果') return call.fail('ARGUMENT_TYPE', '类型须是 "得分" 或 "结果"');
      if (!module) return EMPTY;
      return kind === '得分' ? call.env.fromPlain(module.score) : call.env.fromPlain(module.result);
    },
  },
  {
    name: 'CountModulesWithResult',
    aliases: ['统计指定结果的模块数'],
    params: [param('结果')],
    implement: (call) => {
      const wanted = call.args[0] ?? EMPTY;
      const count = modules(call).filter((module) => {
        const result = call.env.fromPlain(module.result);
        return result.kind !== 'empty' && valuesEqual(result, wanted, call.env.semantics);
      }).length;
      return { kind: 'number', value: count };
    },
  },
  {
    name: 'ModuleJudgeAverage',
    aliases: ['指定模块所有评委平均分'],
    params: [param('模块名')],
    implement: (call) => {
      const module = moduleNamed(call, 0);
      return module ? average(scores(activeJudges(module))) : EMPTY;
    },
  },
  {
    name: 'CountJudgesWithResult',
    aliases: ['统计指定得分或结果的评委数'],
    params: [param('得分或结果'), param('模块名', false)],
    implement: (call) => {
      const wanted = call.args[0] ?? EMPTY;
      const scope =
        call.args.length > 1 ? [moduleNamed(call, 1)].filter((m): m is ReviewModule => m !== undefined) : modules(call);
      const count = scope.flatMap(activeJudges).filter((judge) => judgeMatches(call, judge, wanted)).length;
      return { kind: 'number', value: count };
    },
  },
  {
    name: 'JudgeAverage',
    aliases: ['所有评委平均分'],
    params: [],
    implement: (call) => average(scores(modules(call).flatMap(activeJudges))),
  },
];
