/**
 * 逻辑函数（`26` §8.6 面板 8 个）：AND、OR、IF、IN、NOTIN、是否为空、判断为空、判断不为空。
 * AND / OR / IF 只求值需要的参数（同“且 / 或 / 如果”），未走到的分支不报错。中文别名为复刻命名，
 * 面板上这几个函数只有英文名；判断为空 / 判断不为空 的英文名同理。
 */
import { valuesEqual } from '../operators.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type ExprValue } from '../values.js';

const param = (name: string, required = true, variadic = false) => ({ name, required, variadic });
const bool = (value: boolean): ExprValue => ({ kind: 'boolean', value });

const condition = (call: FunctionCall, index: number) => call.toBoolean(call.evaluate(call.rawArgs[index]!));

/** 空值或空文本为“空”（154894429）。 */
const isBlank = (value: ExprValue) => value.kind === 'empty' || (value.kind === 'text' && value.value === '');

function memberOf(call: FunctionCall): boolean {
  const [value = EMPTY, ...candidates] = call.args;
  return candidates.some((candidate) => valuesEqual(value, candidate, call.env.semantics));
}

const emptyCheck = (name: string, aliases: string[], blank: boolean): FunctionSpec => ({
  name,
  aliases,
  params: [param('值')],
  implement: (call) => bool(isBlank(call.args[0] ?? EMPTY) === blank),
});

export const LOGIC_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'AND',
    aliases: ['全部为真'],
    params: [param('条件', true, true)],
    lazy: true,
    implement: (call) => bool(call.rawArgs.every((_, index) => condition(call, index))),
  },
  {
    name: 'OR',
    aliases: ['任一为真'],
    params: [param('条件', true, true)],
    lazy: true,
    implement: (call) => bool(call.rawArgs.some((_, index) => condition(call, index))),
  },
  {
    name: 'IF',
    aliases: ['条件取值'],
    params: [param('条件'), param('条件为真时的值'), param('条件为假时的值', false)],
    description: '缺第三个参数且条件为假时结果为空（同缺“否则”的 如果）',
    lazy: true,
    implement: (call) => {
      const branch = call.rawArgs[condition(call, 0) ? 1 : 2];
      return branch ? call.evaluate(branch) : EMPTY;
    },
  },
  {
    // TODO(需取证 #105)：IN / NOTIN 的参数形式，暂定 IN(值, 候选1, 候选2, …)，按 = 的口径比较
    name: 'IN',
    aliases: ['属于'],
    params: [param('值'), param('候选值', true, true)],
    implement: (call) => bool(memberOf(call)),
  },
  {
    name: 'NOTIN',
    aliases: ['不属于'],
    params: [param('值'), param('候选值', true, true)],
    implement: (call) => bool(!memberOf(call)),
  },
  emptyCheck('IsEmpty', ['是否为空'], true),
  emptyCheck('IsNull', ['判断为空'], true),
  emptyCheck('IsNotNull', ['判断不为空'], false),
];
