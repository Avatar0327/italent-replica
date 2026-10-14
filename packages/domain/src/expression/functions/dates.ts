/**
 * 日期函数（`26` §8.6 面板日期类、§8.7；DEC-056 / DEC-265）。“今天 / 现在”与时区由计算上下文传入，引擎不读系统时钟。
 * 原站实算确认（DEC-265）：Now / Today 按租户时区；Days(a, b) = b − a；FirstDay / LastDay 为年初 / 年末；
 * WeekDay 周三 = 3。R3e 已核实（`26` 末节，W-862～864）：WeekDay 周日 = 7、NextMonth 取下月同日、Years 按年份相减、
 * Time 两个参数、有效时长三个一组。仍未验证的标 TODO(需取证 #105)。
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
  utcMs,
  type DateUnit,
} from '../dates.js';
import type { ArgumentIssue, FunctionCall, FunctionSpec } from '../registry.js';
import { verdictFor } from '../typing.js';
import type { DateParts, ExprValue } from '../values.js';

const param = (name: string, required = true, variadic = false) => ({ name, required, variadic });
const num = (value: number): ExprValue => ({ kind: 'number', value });
const dateValue = (value: DateParts): ExprValue => ({ kind: 'date', value });
const DAY_MS = 86_400_000;
/** 两个时刻相差的分钟数（结束 − 开始，截断）。 */
const minutesBetween = (from: DateParts, to: DateParts) =>
  Math.trunc((dateOrdinal(to) - dateOrdinal(from)) / 60_000) || 0;

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

/** 日期参数经公共取参（DEC-270：空日期按 0001-01-01，可由 semantics 改为失败）。 */
const dateArg = (call: FunctionCall, index: number) => call.dateArg(call.args, index);
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
  returns: 'number',
  dateParams: [0],
  implement: (call) => num(pick(dateArg(call, 0))),
});

const dateTransform = (name: string, aliases: string[], apply: (parts: DateParts) => DateParts): FunctionSpec => ({
  name,
  aliases,
  params: [param('日期')],
  returns: 'date',
  dateParams: [0],
  implement: (call) => dateValue(apply(dateArg(call, 0))),
});

const dateAddition = (
  name: string,
  aliases: string[],
  apply: (base: DateParts, n: number) => DateParts,
): FunctionSpec => ({
  name,
  aliases,
  params: [param('日期'), param('数量')],
  returns: 'date',
  dateParams: [0],
  implement: (call) => dateValue(apply(dateArg(call, 0), amountArg(call, 1))),
});

/** 两个日期之差，第二个参数减第一个（DEC-265：Days(a, b) = b − a）。 */
const difference = (
  name: string,
  aliases: string[],
  diff: (from: DateParts, to: DateParts) => number,
): FunctionSpec => ({
  name,
  aliases,
  params: [param('开始日期'), param('结束日期')],
  returns: 'number',
  dateParams: [0, 1],
  implement: (call) => num(diff(dateArg(call, 0), dateArg(call, 1))),
});

const utcDay = (parts: DateParts) => new Date(utcMs(parts.year, parts.month, parts.day));
const dayOfYear = (parts: DateParts) => Math.round((utcDay(parts).getTime() - utcMs(parts.year, 1, 1)) / DAY_MS) + 1;
/** 下月同日，下月没有这一天取月末（R3e 实测 NextMonth(2026.01.31) = 2026-02-28）；结果只到日。 */
const nextMonthSameDay = (parts: DateParts) =>
  dateAdd('m', 1, makeDateParts({ year: parts.year, month: parts.month, day: parts.day }));
/** 星期一 = 1 … 星期日 = 7（DEC-265 周三 = 3；R3e 实测周日 = 7）。 */
const isoWeekDay = (parts: DateParts) => utcDay(parts).getUTCDay() || 7;

/** Time(日期, 时间)：日期部分取第一个参数，时分秒取第二个参数，省略时为 00:00（R3e 说明原文）。 */
function combineTime(call: FunctionCall): ExprValue {
  const date = dateArg(call, 0);
  const time = call.args.length > 1 ? dateArg(call, 1) : makeDateParts({ year: 1, month: 1, day: 1 });
  const { hour, minute, second } = time;
  return dateValue({ year: date.year, month: date.month, day: date.day, hour, minute, second, precision: 'datetime' });
}

/** 有效时长每组三个参数：开始、结束、0 或 1。 */
const DURATION_GROUP = 3;

/**
 * 有效时长（旧名 EffectiveTime）：按“开始、结束、0 或 1”三个一组，可重复多组；1 累加、0 扣除，单位分钟（R3e 说明原文）。
 * 每组分钟数同 Minutes（结束 − 开始，截断）；TODO(需取证 #105)：Minutes 的方向与截断仍未验证。
 */
function effectiveDuration(call: FunctionCall): ExprValue {
  if (call.args.length % DURATION_GROUP !== 0) {
    return call.fail('ARGUMENT_COUNT', '有效时长的参数须按“开始、结束、0 或 1”三个一组');
  }
  let total = 0;
  for (let start = 0; start < call.args.length; start += DURATION_GROUP) {
    const minutes = minutesBetween(dateArg(call, start), dateArg(call, start + 1));
    const flag = call.numberArg(call.args, start + 2);
    if (flag !== 0 && flag !== 1)
      return call.fail('ARGUMENT_TYPE', '有效时长每组第三个参数只能是 0（扣除）或 1（累加）');
    total += flag === 1 ? minutes : -minutes;
  }
  return num(total);
}

/** 有效时长的保存检查：参数个数须是 3 的倍数；每组开始、结束须是日期（同 dateParams 的口径，DEC-270②）。 */
const durationCheck: FunctionSpec['checkArgs'] = (args, infer) => {
  if (args.length % DURATION_GROUP !== 0) {
    return [{ severity: 'error', message: `参数须按“开始、结束、0 或 1”三个一组，现有 ${args.length} 个` }];
  }
  const issues: ArgumentIssue[] = [];
  args.forEach((arg, index) => {
    if (index % DURATION_GROUP === 2) return;
    const verdict = verdictFor(infer(arg), 'date');
    if (verdict === 'mismatch') issues.push({ severity: 'error', message: `第${index + 1}个参数应为日期或日期时间` });
    if (verdict === 'uncertain') {
      issues.push({
        severity: 'warning',
        message: `第${index + 1}个参数类型不确定（应为日期），计算时不是日期将计算失败`,
      });
    }
  });
  return issues;
};
const byUnit = (unit: DateUnit) => (base: DateParts, n: number) => dateAdd(unit, n, base);

export const DATE_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Today',
    aliases: ['今天', '当前日期'],
    params: [],
    returns: 'date',
    description: '租户时区下的业务日期“今天”0 点，由计算上下文传入（DEC-056 / DEC-265）',
    implement: (call) => dateValue(today(call)),
  },
  {
    name: 'Now',
    aliases: ['现在', '当前时间'],
    params: [],
    returns: 'date',
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
  // R3e 已核实（`26` 末节，W-862）：周日 = 7
  datePart('WeekDay', ['星期'], isoWeekDay),
  {
    // R3e 已核实（`26` 末节，W-864 说明原文）：Time(日期, 时间)，时间省略时为 00:00
    name: 'Time',
    aliases: ['时间'],
    params: [param('日期'), param('时间', false)],
    returns: 'date',
    dateParams: [0, 1],
    implement: combineTime,
  },
  {
    name: 'ToDate',
    aliases: ['转换为日期'],
    params: [param('值')],
    returns: 'date',
    implement: (call) => dateValue(dateArg(call, 0)),
  },
  // DEC-265：FirstDay / LastDay 是该年的 1 月 1 日 / 12 月 31 日，不是月初月末
  dateTransform('FirstDay', ['年初'], (parts) => makeDateParts({ year: parts.year, month: 1, day: 1 })),
  dateTransform('LastDay', ['年末'], (parts) => makeDateParts({ year: parts.year, month: 12, day: 31 })),
  // R3e 已核实（`26` 末节，W-862）：下月同日，没有这一天取月末
  dateTransform('NextMonth', ['下月'], nextMonthSameDay),
  dateAddition('AddYears', ['加年'], byUnit('y')),
  dateAddition('AddMonths', ['加月'], byUnit('m')),
  dateAddition('AddDays', ['加天'], byUnit('d')),
  dateAddition('AddHours', ['加小时'], (base, n) => addMinutes(base, n * 60)),
  dateAddition('AddMinutes', ['加分钟'], addMinutes),
  difference('Days', ['天数'], (from, to) => dateDiff('d', from, to)),
  // R3e 已核实（`26` 末节，W-862）：Years("2020.06.30", "2026.06.29") = 6，按年份相减（结束年 − 开始年）。
  // TODO(需取证 #105)：Years 的精度 / 舍入未验证；Minutes 的方向与截断未验证，维持暂定
  difference('Years', ['年数'], (from, to) => to.year - from.year),
  difference('Minutes', ['分钟数'], minutesBetween),
  {
    // R3e 已核实（`26` 末节，W-864 说明原文）：三个一组可重复；英文名为复刻命名（说明里的旧名 EffectiveTime 作别名）
    name: 'EffectiveDuration',
    aliases: ['有效时长', 'EffectiveTime'],
    params: [param('开始'), param('结束'), param('0 或 1', true, true)],
    returns: 'number',
    checkArgs: durationCheck,
    implement: effectiveDuration,
  },
  {
    name: 'DateDiff',
    aliases: ['日期差'],
    params: [param('单位'), param('开始日期'), param('结束日期')],
    returns: 'number',
    dateParams: [1, 2],
    description: '结束 − 开始：d 自然日，m / y 满月 / 满年',
    implement: (call) => num(dateDiff(unitArg(call, 0), dateArg(call, 1), dateArg(call, 2))),
  },
  {
    name: 'DateAdd',
    aliases: ['日期加'],
    params: [param('单位'), param('数量'), param('日期')],
    returns: 'date',
    dateParams: [2],
    implement: (call) => dateValue(dateAdd(unitArg(call, 0), amountArg(call, 1), dateArg(call, 2))),
  },
  {
    name: 'DateFormat',
    aliases: ['日期格式化'],
    params: [param('日期'), param('格式')],
    returns: 'text',
    dateParams: [0],
    description: '.NET 风格格式符：yyyy MM dd HH mm ss tt 等（221160022）',
    implement: (call) => ({ kind: 'text', value: formatDate(dateArg(call, 0), call.textArg(call.args, 1)) }),
  },
];
