/**
 * 通用函数（`26` §8.1）：类型转换、判空、聚合、数值与文本。
 */
import { operandNumber, toNumberValue } from '../operators.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type ExprValue } from '../values.js';
import { average } from './shared.js';

const param = (name: string, required = true, variadic = false) => ({ name, required, variadic });

function aggregateNumbers(call: FunctionCall): number[] {
  const numbers: number[] = [];
  for (const value of call.args) {
    const n = operandNumber(value, call.env.semantics, 'EMPTY_IN_AGGREGATE');
    if (n !== undefined) numbers.push(n);
  }
  return numbers;
}

function aggregate(name: string, aliases: string[], reduce: (numbers: number[]) => ExprValue): FunctionSpec {
  return {
    name,
    aliases,
    params: [param('数值', true, true)],
    implement: (call) => reduce(aggregateNumbers(call)),
  };
}

const roundTo = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor + Number.EPSILON * Math.sign(value)) / factor;
};

export const CORE_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'ToNumber',
    aliases: ['转换为数字', '转换为数值'],
    params: [param('值')],
    description: '文本 / 百分比 / 是否 / 单选值转数值；空值转为 0（DEC-257）',
    implement: (call) => toNumberValue(call.args[0] ?? EMPTY, call.env.semantics),
  },
  {
    name: 'ToText',
    aliases: ['转换为文本', 'ToString'],
    params: [param('值')],
    implement: (call) => ({ kind: 'text', value: call.toText(call.args[0] ?? EMPTY) }),
  },
  {
    name: 'ToDate',
    aliases: ['转换为日期'],
    params: [param('值')],
    implement: (call) => ({ kind: 'date', value: call.toDate(call.args[0] ?? EMPTY) }),
  },
  {
    name: 'IsEmpty',
    aliases: ['是否为空'],
    params: [param('值')],
    description: '空值或空文本为真（154894429）',
    implement: (call) => {
      const value = call.args[0] ?? EMPTY;
      return { kind: 'boolean', value: value.kind === 'empty' || (value.kind === 'text' && value.value === '') };
    },
  },
  aggregate('Average', ['平均值', '平均'], average),
  aggregate('Sum', ['求和', '合计'], (numbers) => ({ kind: 'number', value: numbers.reduce((sum, n) => sum + n, 0) })),
  aggregate('Max', ['最大值'], (numbers) => (numbers.length ? { kind: 'number', value: Math.max(...numbers) } : EMPTY)),
  aggregate('Min', ['最小值'], (numbers) => (numbers.length ? { kind: 'number', value: Math.min(...numbers) } : EMPTY)),
  {
    name: 'Round',
    aliases: ['四舍五入'],
    params: [param('数值'), param('小数位数', false)],
    implement: (call) => {
      const digits = call.args.length > 1 ? call.numberArg(call.args, 1) : 0;
      return { kind: 'number', value: roundTo(call.numberArg(call.args, 0), digits) };
    },
  },
  {
    name: 'Abs',
    aliases: ['绝对值'],
    params: [param('数值')],
    implement: (call) => ({ kind: 'number', value: Math.abs(call.numberArg(call.args, 0)) }),
  },
  {
    name: 'Length',
    aliases: ['长度', 'Len'],
    params: [param('文本')],
    implement: (call) => ({ kind: 'number', value: [...call.textArg(call.args, 0)].length }),
  },
  {
    name: 'Contains',
    aliases: ['包含'],
    params: [param('文本'), param('子串')],
    implement: (call) => ({ kind: 'boolean', value: call.textArg(call.args, 0).includes(call.textArg(call.args, 1)) }),
  },
  {
    name: 'Concat',
    aliases: ['连接', '拼接'],
    params: [param('值', true, true)],
    implement: (call) => ({ kind: 'text', value: call.args.map((value) => call.toText(value)).join('') }),
  },
];
