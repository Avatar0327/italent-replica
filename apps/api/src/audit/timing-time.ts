/**
 * 计时审计事件的发生时间披露（DEC-405①）：建立 / 翻页事件的发生时间就是打开 / 翻页时刻，与提交事件的时间相减即得耗时，
 * 所以披露时模糊到租户当地日的 00:00。粒度选“日”：评价过快的阈值是每题 1.5 秒、整份答卷通常几十秒到几十分钟，
 * 任何小于日的粒度（时、分）都可能让“打开—提交”跨越的区间落进阈值附近；日粒度下同一天内的先后无法区分，
 * 只保留“哪天打开过”。列表排序与分页仍按库内真实时间，披露值只影响显示。
 */
import { tenantLocalDate } from '@italent/domain';
import { TIMING_BLURRED_ACTIONS, TIMING_AUDIT_TYPE } from '../modules/survey360/timing-audit.js';

const HOUR_MS = 3_600_000;

/**
 * instant 所在租户当地日的第一个有效时刻。不用“当地 00:00 减偏移”的算术：当地零点可能不存在（圣地亚哥夏令时从 00:00
 * 跳到 01:00）或出现两次（哈瓦那夏令时结束），那样会落到前一天。改为：先按小时向前扫到当日第一个整点，再在前一小时内
 * 二分到当日最早的毫秒。
 */
export function tenantDayStart(instant: Date, timeZone: string): Date {
  const day = tenantLocalDate(instant, timeZone);
  const isDay = (t: number) => tenantLocalDate(new Date(t), timeZone) === day;
  const end = instant.getTime();
  let first = end;
  // 一天最长 25 小时，向前最多回溯 48 小时
  for (let t = end - 48 * HOUR_MS; t <= end; t += HOUR_MS) {
    if (isDay(t)) {
      first = t;
      break;
    }
  }
  let before = first - HOUR_MS;
  if (isDay(before)) return new Date(before); // 不会发生（回溯范围已足够），兜底
  while (first - before > 1) {
    const mid = Math.floor((before + first) / 2);
    if (isDay(mid)) first = mid;
    else before = mid;
  }
  return new Date(first);
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
