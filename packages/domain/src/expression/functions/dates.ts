/**
 * 日期函数（`26` §8.6 面板日期类、§8.7；DEC-056 / DEC-265）。“今天 / 现在”与时区由计算上下文传入，引擎不读系统时钟。
 * 原站实算确认（DEC-265）：Now / Today 按租户时区；Days(a, b) = b − a；FirstDay / LastDay 为年初 / 年末；
 * WeekDay 周三 = 3。其余函数的参数与返回值按手册 221160022 暂定，标 TODO(需取证 #105)。
 * 中文别名为复刻命名（面板上日期函数除“有效时长”外只有英文名）。
 */
import {
  addMinutes,
  dateAdd,
  dateDiff,
  dateOrdinal,
  formatDate,
  instantToParts,
  makeDateParts,
  parseDateText,
  parseDateUnit,
  type DateUnit,
} from '../dates.js';
import type { FunctionCall, FunctionSpec } from '../registry.js';
import { EMPTY, type DateParts, type ExprValue } from '../values.js';

const param = (name: string, required = true) => ({ name, required });
const num = (value: number): ExprValue => ({ kind: 'number', value });
const dateValue = (value: DateParts): ExprValue => ({ kind: 'date', value });
const DAY_MS = 86_400_000;

function today(call: FunctionCall): DateParts {
  const parsed = parseDateText(call.env.calendar.today);
  if (!parsed) return call.fail('TYPE_CONVERSION', `计算上下文的今天不是合法日期：${call.env.calendar.today}`);
  return parsed;
}

function now(call: FunctionCall): DateParts {
  const instant = call.env.calendar.now;
  if (!instant) return call.fail('CONTEXT_INVALID', '计算上下文没有提供当前时刻，无法计算 Now()');
  return instantToParts(instant, call.env.calendar.timeZone);
}

const dateArg = (call: FunctionCall, index: number) => call.toDate(call.args[index] ?? EMPTY);
/** 加减数量经公共取参（DEC-264）；TODO(需取证 #105)：带小数时原站的处理，暂截断取整。 */
const amountArg = (call: FunctionCall, index: number) => Math.trunc(call.numberArg(call.args, index));

function unitArg(call: FunctionCall, index: number) {
  const unit = parseDateUnit(call.textArg(call.args, index));
  return unit ?? call.fail('ARGUMENT_TYPE', '日期单位须是 d / m / y（日 / 月 / 年）');
}

const datePart = (name: string, aliases: string[], pick: (parts: DateParts) => number): FunctionSpec => ({
  name,
  aliases,
  params: [param('日期')],
  implement: (call) => num(pick(dateArg(call, 0))),
});

const dateTransform = (name: string, aliases: string[], apply: (parts: DateParts) => DateParts): FunctionSpec => ({
  name,
  aliases,
  params: [param('日期')],
  implement: (call) => dateValue(apply(dateArg(call, 0))),
});

const dateAddition = (name: string, aliases: string[], apply: (base: DateParts, n: number) => DateParts) => ({
  name,
  aliases,
  params: [param('日期'), param('数量')],
  implement: (call: FunctionCall) => dateValue(apply(dateArg(call, 0), amountArg(call, 1))),
});

/** 两个日期之差，第二个参数减第一个（DEC-265：Days(a, b) = b − a）。 */
const difference = (name: string, aliases: string[], diff: (from: DateParts, to: DateParts) => number) => ({
  name,
  aliases,
  params: [param('开始日期'), param('结束日期')],
  implement: (call: FunctionCall) => num(diff(dateArg(call, 0), dateArg(call, 1))),
});

const utcDay = (parts: DateParts) => new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
const dayOfYear = (parts: DateParts) => Math.round((utcDay(parts).getTime() - Date.UTC(parts.year, 0, 1)) / DAY_MS) + 1;
const timeOnly = (parts: DateParts): DateParts => ({ ...parts, year: 1, month: 1, day: 1, precision: 'time' });
const nextMonthFirstDay = (parts: DateParts) =>
  dateAdd('m', 1, makeDateParts({ year: parts.year, month: parts.month, day: 1 }));
const byUnit = (unit: DateUnit) => (base: DateParts, n: number) => dateAdd(unit, n, base);

export const DATE_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Today',
    aliases: ['今天', '当前日期'],
    params: [],
    description: '租户时区下的业务日期“今天”0 点，由计算上下文传入（DEC-056 / DEC-265）',
    implement: (call) => dateValue(today(call)),
  },
  {
    name: 'Now',
    aliases: ['现在', '当前时间'],
    params: [],
    description: '当前时刻按租户时区换算的墙上时间（DEC-265）',
    implement: (call) => dateValue(now(call)),
  },
  datePart('DayOfYear', ['年中第几天'], dayOfYear),
  datePart('Year', ['年'], (parts) => parts.year),
  datePart('Month', ['月'], (parts) => parts.month),
  datePart('Day', ['日'], (parts) => parts.day),
  datePart('Hour', ['小时'], (parts) => parts.hour),
  datePart('Minute', ['分钟'], (parts) => parts.minute),
  datePart('Second', ['秒'], (parts) => parts.second),
  // DEC-265：周三 = 3；TODO(需取证 #105)：周日暂按 0（同 .NET DayOfWeek）
  datePart('WeekDay', ['星期'], (parts) => utcDay(parts).getUTCDay()),
  // TODO(需取证 #105)：Time 的参数与返回值，暂定 Time(日期) 取时分秒部分
  dateTransform('Time', ['时间'], timeOnly),
  {
    name: 'ToDate',
    aliases: ['转换为日期'],
    params: [param('值')],
    implement: (call) => dateValue(dateArg(call, 0)),
  },
  // DEC-265：FirstDay / LastDay 是该年的 1 月 1 日 / 12 月 31 日，不是月初月末
  dateTransform('FirstDay', ['年初'], (parts) => makeDateParts({ year: parts.year, month: 1, day: 1 })),
  dateTransform('LastDay', ['年末'], (parts) => makeDateParts({ year: parts.year, month: 12, day: 31 })),
  // TODO(需取证 #105)：NextMonth 返回下月 1 日还是下月同日，暂定下月 1 日
  dateTransform('NextMonth', ['下月'], nextMonthFirstDay),
  dateAddition('AddYears', ['加年'], byUnit('y')),
  dateAddition('AddMonths', ['加月'], byUnit('m')),
  dateAddition('AddDays', ['加天'], byUnit('d')),
  dateAddition('AddHours', ['加小时'], (base, n) => addMinutes(base, n * 60)),
  dateAddition('AddMinutes', ['加分钟'], addMinutes),
  difference('Days', ['天数'], (from, to) => dateDiff('d', from, to)),
  // TODO(需取证 #105)：Years 按满年、Minutes 截断，暂定
  difference('Years', ['年数'], (from, to) => dateDiff('y', from, to)),
  difference('Minutes', ['分钟数'], (from, to) => Math.trunc((dateOrdinal(to) - dateOrdinal(from)) / 60_000) || 0),
  {
    // TODO(需取证 #105)：面板“有效时长( , , , , , )”六个参数的含义原站未说明；已注册可保存，求值时失败
    name: 'EffectiveDuration',
    aliases: ['有效时长'],
    params: ['参数1', '参数2', '参数3', '参数4', '参数5', '参数6'].map((name) => param(name)),
    lazy: true,
    implement: (call) => call.fail('FUNCTION_UNAVAILABLE', '有效时长 的参数与口径待取证，暂不能计算'),
  },
  {
    name: 'DateDiff',
    aliases: ['日期差'],
    params: [param('单位'), param('开始日期'), param('结束日期')],
    description: '结束 − 开始：d 自然日，m / y 满月 / 满年',
    implement: (call) => num(dateDiff(unitArg(call, 0), dateArg(call, 1), dateArg(call, 2))),
  },
  {
    name: 'DateAdd',
    aliases: ['日期加'],
    params: [param('单位'), param('数量'), param('日期')],
    implement: (call) => dateValue(dateAdd(unitArg(call, 0), amountArg(call, 1), dateArg(call, 2))),
  },
  {
    name: 'DateFormat',
    aliases: ['日期格式化'],
    params: [param('日期'), param('格式')],
    description: '.NET 风格格式符：yyyy MM dd HH mm ss tt 等（221160022）',
    implement: (call) => ({ kind: 'text', value: formatDate(dateArg(call, 0), call.textArg(call.args, 1)) }),
  },
];
