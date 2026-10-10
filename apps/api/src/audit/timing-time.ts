/**
 * 计时审计事件的发生时间披露（DEC-405①）：建立 / 翻页事件的发生时间就是打开 / 翻页时刻，与提交事件的时间相减即得耗时，
 * 所以披露时模糊到租户当地日的 00:00。粒度选“日”：评价过快的阈值是每题 1.5 秒、整份答卷通常几十秒到几十分钟，
 * 任何小于日的粒度（时、分）都可能让“打开—提交”跨越的区间落进阈值附近；日粒度下同一天内的先后无法区分，
 * 只保留“哪天打开过”。列表排序与分页仍按库内真实时间，披露值只影响显示。
 */
import { tenantLocalDate } from '@italent/domain';
import { TIMING_BLURRED_ACTIONS, TIMING_AUDIT_TYPE } from '../modules/survey360/timing-audit.js';

/** 时区在 instant 时刻相对 UTC 的偏移（毫秒）。 */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return local - Math.floor(instant / 1000) * 1000;
}

/** instant 所在租户当地日的 00:00 对应的时刻。 */
export function tenantDayStart(instant: Date, timeZone: string): Date {
  const [year, month, day] = tenantLocalDate(instant, timeZone).split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, day);
  // 先按 naive 时刻的偏移估计，再按估计结果的偏移修正一次（跨夏令时切换日）
  const guess = naive - zoneOffsetMs(naive, timeZone);
  return new Date(naive - zoneOffsetMs(guess, timeZone));
}

/** 审计查看显示的发生时间：计时的建立 / 翻页事件模糊到当地日，其他事件原样。 */
export function disclosedOccurredAt(
  row: { objectType: string; action: string; occurredAt: Date | string },
  timeZone: string,
): string {
  const exact = new Date(row.occurredAt);
  if (row.objectType !== TIMING_AUDIT_TYPE || !TIMING_BLURRED_ACTIONS.includes(row.action)) return exact.toISOString();
  return tenantDayStart(exact, timeZone).toISOString();
}
