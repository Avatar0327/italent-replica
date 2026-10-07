/**
 * 通用函数（`26` §8.6 统计 / 文本 / 其它类）：类型转换、聚合、计数与文本。
 */
import { ComputationError } from '../failures.js';
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

/** ToNumber：空值按 semantics（DEC-257 默认 0）；转不了数值的文本 / 单选为 0（DEC-265，原站 ToNumber("abc") = 0）。 */
function toNumberFunction(call: FunctionCall): ExprValue {
  const value = call.args[0] ?? EMPTY;
  try {
    return toNumberValue(value, call.env.semantics);
  } catch (error) {
    const textual = value.kind === 'text' || value.kind === 'option';
    if (textual && error instanceof ComputationError && error.failure.code === 'TYPE_CONVERSION') {
      return { kind: 'number', value: 0 };
    }
    throw error;
  }
}

export const CORE_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'ToNumber',
    aliases: ['转换为数字', '转换为数值'],
    params: [param('值')],
    description: '文本 / 百分比 / 是否 / 单选值转数值；空值转为 0（DEC-257）；非数字文本为 0（DEC-265）',
    implement: toNumberFunction,
  },
  {
    name: 'ToText',
    aliases: ['转换为文本', 'ToString'],
    params: [param('值')],
    implement: (call) => ({ kind: 'text', value: call.toText(call.args[0] ?? EMPTY) }),
  },
  aggregate('Average', ['平均值', '平均'], average),
  aggregate('Sum', ['求和', '合计'], (numbers) => ({ kind: 'number', value: numbers.reduce((sum, n) => sum + n, 0) })),
  aggregate('Max', ['最大值'], (numbers) => (numbers.length ? { kind: 'number', value: Math.max(...numbers) } : EMPTY)),
  aggregate('Min', ['最小值'], (numbers) => (numbers.length ? { kind: 'number', value: Math.min(...numbers) } : EMPTY)),
  {
    // DEC-265：Count(1, "", 3) = 3，空串计数；TODO(需取证 #105)：空值是否计数，暂按计数
    name: 'Count',
    aliases: ['计数'],
    params: [param('值', true, true)],
    implement: (call) => ({ kind: 'number', value: call.args.length }),
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
    // 面板名 Concatenate（§8.6）；Concat 是 R3-T00 时的命名，保留兼容
    name: 'Concatenate',
    aliases: ['Concat', '连接', '拼接'],
    params: [param('值', true, true)],
    implement: (call) => ({ kind: 'text', value: call.args.map((value) => call.toText(value)).join('') }),
  },
  {
    // TODO(需取证 #105)：ShowText 的用途原站未说明，暂把参数原样转成文本
    name: 'ShowText',
    aliases: ['显示文本'],
    params: [param('值')],
    implement: (call) => ({ kind: 'text', value: call.toText(call.args[0] ?? EMPTY) }),
  },
];
