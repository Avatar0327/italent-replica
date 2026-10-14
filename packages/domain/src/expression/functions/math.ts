/**
 * 数学函数（`26` §8.6 面板 9 个）：Round、RoundUP、RoundDown、四舍五入、INT、Floor、Ceiling、Abs、Mod。
 * 数值参数一律经公共取参 call.numberArg（DEC-270①：空值按 semantics 配置计算失败或按 0，数字字符串按数值）。
 * 中文别名除“四舍五入”外为复刻命名。
 */
import type { FunctionCall, FunctionSpec } from '../registry.js';
import type { ExprValue } from '../values.js';

const param = (name: string, required = true) => ({ name, required });
const num = (value: number): ExprValue => ({ kind: 'number', value });

/** 小数位数的范围：超出时计算失败，避免构造过大的十进制数。 */
const MAX_DIGITS = 300;

/** 小数位参数：省略为 0，按整数截断（经公共取参，DEC-270①）。 */
function digitsArg(call: FunctionCall, index: number): number {
  if (call.args.length <= index) return 0;
  const digits = Math.trunc(call.numberArg(call.args, index));
  if (Math.abs(digits) > MAX_DIGITS)
    return call.fail('ARGUMENT_TYPE', `小数位数须在 -${MAX_DIGITS}～${MAX_DIGITS} 之间`);
  return digits;
}

/** 按绝对值舍入的方式：四舍五入（远离 0）、远离 0 进位、趋向 0 舍去。 */
export type Rounding = 'half-up' | 'up' | 'down';

/**
 * 按输入值的十进制表示精确舍入（PR #108 第 3 轮清单 P3）：取能精确还原该双精度数的最短十进制写法（toExponential），
 * 用 BigInt 定点舍入，不做任何浮点误差修正。因此 RoundDown(0.9999999999999999) = 0、RoundUP(1.0000000000000002) = 2；
 * 运算产生的尾差也按输入值计算，如 1.1 * 3 的输入值是 3.3000000000000003，RoundUP(1.1 * 3, 1) = 3.4。
 * C-02：导出给人才盘点的指标 / 模块算分（R3-T04 设计 §4.2），保证算分精度与公式里的 Round 系列一致。
 */
export function roundDecimal(value: number, digits: number, mode: Rounding): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const [mantissa = '', exponent = '0'] = Math.abs(value).toExponential().split('e');
  const significand = mantissa.replace('.', '');
  // 值 = significand × 10^(exponent − (位数 − 1))；保留 digits 位小数需去掉 dropped 位
  const dropped = significand.length - 1 - Number(exponent) - digits;
  if (dropped <= 0) return value;
  let kept: bigint;
  if (dropped > significand.length + 1) {
    // 舍入位在全部有效数字之前：四舍五入与舍去都为 0，进位为 1 个最小单位
    kept = mode === 'up' ? 1n : 0n;
  } else {
    const scale = 10n ** BigInt(dropped);
    const whole = BigInt(significand);
    const rest = whole % scale;
    kept = whole / scale;
    if (mode === 'up' ? rest > 0n : mode === 'half-up' && rest * 2n >= scale) kept += 1n;
  }
  if (kept === 0n) return 0;
  return Math.sign(value) * Number(`${kept}e${-digits}`);
}

const rounding = (name: string, aliases: string[], mode: Rounding): FunctionSpec => ({
  name,
  aliases,
  params: [param('数值'), param('小数位数', false)],
  returns: 'number',
  implement: (call) => num(roundDecimal(call.numberArg(call.args, 0), digitsArg(call, 1), mode)),
});

const unary = (name: string, aliases: string[], apply: (value: number) => number): FunctionSpec => ({
  name,
  aliases,
  params: [param('数值')],
  returns: 'number',
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
  rounding('Round', ['四舍五入'], 'half-up'),
  rounding('RoundUP', ['向上舍入'], 'up'),
  rounding('RoundDown', ['向下舍入'], 'down'),
  // TODO(需取证 #105)：INT 对负数向下取整（Excel，INT(-2.5) = -3）还是截断；Floor / Ceiling 是否有基数参数
  unary('INT', ['取整'], Math.floor),
  unary('Floor', ['向下取整'], Math.floor),
  unary('Ceiling', ['向上取整'], Math.ceil),
  unary('Abs', ['绝对值'], Math.abs),
  {
    name: 'Mod',
    aliases: ['取余', '求余'],
    params: [param('被除数'), param('除数')],
    returns: 'number',
    implement: mod,
  },
];
