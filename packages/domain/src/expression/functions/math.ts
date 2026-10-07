/**
 * 数学函数（`26` §8.6 面板 9 个）：Round、RoundUP、RoundDown、四舍五入、INT、Floor、Ceiling、Abs、Mod。
 * 数值参数一律经公共取参 call.numberArg（DEC-264：空值按 semantics 配置按 0 或计算失败，数字字符串按数值）。
 * 中文别名除“四舍五入”外为复刻命名。
 */
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { ExprValue } from '../values.js';

const param = (name: string, required = true) => ({ name, required });
const num = (value: number): ExprValue => ({ kind: 'number', value });

/** 小数位参数：省略为 0，按整数截断。 */
const digitsArg = (call: FunctionCall, index: number) =>
  call.args.length > index ? Math.trunc(call.numberArg(call.args, index)) : 0;

/** 放大到整数位后先按 15 位有效数字规整，避免 1.1 * 3 = 3.3000000000000003 被向上舍入成 3.4。 */
function roundWith(mode: (scaled: number) => number, value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = (Math.sign(value) * mode(scaled)) / factor;
  return rounded === 0 ? 0 : rounded;
}

const rounding = (name: string, aliases: string[], mode: (scaled: number) => number): FunctionSpec => ({
  name,
  aliases,
  params: [param('数值'), param('小数位数', false)],
  implement: (call) => num(roundWith(mode, call.numberArg(call.args, 0), digitsArg(call, 1))),
});

const unary = (name: string, aliases: string[], apply: (value: number) => number): FunctionSpec => ({
  name,
  aliases,
  params: [param('数值')],
  implement: (call) => num(apply(call.numberArg(call.args, 0)) || 0),
});

/** Mod：结果符号跟除数（Excel MOD，取余(-7, 3) = 2）；TODO(需取证 #105)：原站是否同 .NET % 跟被除数。 */
function mod(call: FunctionCall): ExprValue {
  const dividend = call.numberArg(call.args, 0);
  const divisor = call.numberArg(call.args, 1);
  if (divisor === 0) return call.fail('DIVISION_BY_ZERO', '除数为 0');
  return num(dividend - divisor * Math.floor(dividend / divisor) || 0);
}

export const MATH_FUNCTIONS: readonly FunctionSpec[] = [
  // 四舍五入、远离 0（DEC-265：Round(2.5, 0) = 3；面板的“四舍五入”同义）
  rounding('Round', ['四舍五入'], (scaled) => Math.floor(scaled + 0.5)),
  rounding('RoundUP', ['向上舍入'], Math.ceil),
  rounding('RoundDown', ['向下舍入'], Math.floor),
  // TODO(需取证 #105)：INT 对负数向下取整（Excel，INT(-2.5) = -3）还是截断；Floor / Ceiling 是否有基数参数
  unary('INT', ['取整'], Math.floor),
  unary('Floor', ['向下取整'], Math.floor),
  unary('Ceiling', ['向上取整'], Math.ceil),
  unary('Abs', ['绝对值'], Math.abs),
  {
    name: 'Mod',
    aliases: ['取余', '求余'],
    params: [param('被除数'), param('除数')],
    implement: mod,
  },
];
