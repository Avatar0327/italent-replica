/**
 * 日期函数（`26` §8.3；DEC-056）。today() 来自上下文；🟡 待 Q-M0-83。
 */
import { dateAdd, dateDiff, formatDate, parseDateText, parseDateUnit } from '../dates.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type DateParts } from '../values.js';

const param = (name: string, required = true) => ({ name, required });

function today(call: FunctionCall): DateParts {
  const parsed = parseDateText(call.env.calendar.today);
  if (!parsed) return call.fail('TYPE_CONVERSION', `计算上下文的今天不是合法日期：${call.env.calendar.today}`);
  return parsed;
}

function unitArg(call: FunctionCall, index: number) {
  const unit = parseDateUnit(call.textArg(call.args, index));
  return unit ?? call.fail('ARGUMENT_TYPE', '日期单位须是 d / m / y（日 / 月 / 年）');
}

const datePart = (name: string, aliases: string[], pick: (parts: DateParts) => number): FunctionSpec => ({
  name,
  aliases,
  params: [param('日期')],
  implement: (call) => ({ kind: 'number', value: pick(call.toDate(call.args[0] ?? EMPTY)) }),
});

export const DATE_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Today',
    aliases: ['今天', '当前日期'],
    params: [],
    description: '租户时区下的业务日期“今天”，由计算上下文传入（DEC-056）',
    implement: (call) => ({ kind: 'date', value: today(call) }),
  },
  datePart('Year', ['年'], (parts) => parts.year),
  datePart('Month', ['月'], (parts) => parts.month),
  datePart('Day', ['日'], (parts) => parts.day),
  {
    name: 'DateDiff',
    aliases: ['日期差'],
    params: [param('单位'), param('开始日期'), param('结束日期')],
    description: '结束 − 开始：d 自然日，m / y 满月 / 满年',
    implement: (call) => ({
      kind: 'number',
      value: dateDiff(unitArg(call, 0), call.toDate(call.args[1] ?? EMPTY), call.toDate(call.args[2] ?? EMPTY)),
    }),
  },
  {
    name: 'DateAdd',
    aliases: ['日期加'],
    params: [param('单位'), param('数量'), param('日期')],
    implement: (call) => ({
      kind: 'date',
      value: dateAdd(unitArg(call, 0), Math.trunc(call.numberArg(call.args, 1)), call.toDate(call.args[2] ?? EMPTY)),
    }),
  },
  {
    name: 'DateFormat',
    aliases: ['日期格式化'],
    params: [param('日期'), param('格式')],
    description: '.NET 风格格式符：yyyy MM dd HH mm ss tt 等',
    implement: (call) => ({
      kind: 'text',
      value: formatDate(call.toDate(call.args[0] ?? EMPTY), call.textArg(call.args, 1)),
    }),
  },
];
