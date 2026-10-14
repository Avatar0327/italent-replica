import { assertValidTimeZone } from '@italent/domain';
import type { CalcInput } from './calc-contract.js';

/** §4.6 / DEC-431①：唯一的定时时间入口；日期校验、日起点、槽序号使用同一份时区规则。
 * 先求午夜所有有效映射并取最早者；午夜不存在时取跳变后的首个有效瞬时，不能截断负分钟数。
 * 与 Temporal GetStartOfDay 的“最早午夜，否则跳变点”语义一致，不依赖 PG 歧义时间的默认选边。 */
export function calcScheduleSlot(input: CalcInput) {
  const { now, timezone, intervalHours: h } = input;
  if (!now || !Number.isFinite(now.getTime()) || !timezone) throw new TypeError('缺少合法定时时间或时区');
  assertValidTimeZone(timezone);
  if (input.kind === 'org_stats' && (!Number.isInteger(h) || h! < 1 || h! > 24))
    throw new TypeError('统计间隔必须为 1～24 小时');
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const wall = (instant: number) => {
    const parts = format.formatToParts(instant);
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    return Date.parse(
      `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`,
    );
  };
  const businessDate = new Date(wall(now.getTime())).toISOString().slice(0, 10);
  if (input.businessDate !== businessDate) throw new TypeError('定时业务日期必须与租户槽日期相同');
  const midnight = Date.parse(`${businessDate}T00:00:00Z`);
  const hour = 3600000;
  const candidates: number[] = [];
  // 在目标日期前后观察偏移，再往返验证午夜；重复午夜的两个候选都必须保留。
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = midnight + delta * hour;
    const candidate = midnight - (wall(sample) - sample);
    if (wall(candidate) === midnight) candidates.push(candidate);
  }
  let start = Math.min(...candidates);
  if (!candidates.length) {
    // 午夜处于跳空区间：下界在前一业务日，上界是已知属于目标日的瞬时。
    let lower = midnight - 36 * hour;
    let upper = now.getTime();
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2);
      if (wall(middle) < midnight) lower = middle;
      else upper = middle;
    }
    start = upper;
  }
  return {
    businessDate,
    dayStart: new Date(start),
    slotIndex: input.kind === 'org_stats' ? Math.floor((now.getTime() - start) / (h! * hour)) : undefined,
  };
}
