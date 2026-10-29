/** R255-1 P2-1：前端日期换算后的真实 HTTP / PG 查询，避免 30 天窗口静默漏行。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { listPath } from '../../apps/web/src/part-time/model.js';
import { viewsWorld, type ViewBody } from './AC-PT-views-support.js';

const database = useTestDb();
const dateAt = (today: string, days: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

describe('AC-PT-F255-expiring-range 日期区间与到期窗口一致', () => {
  it('截止日拉到第 60 天时返回第 45 天到期记录，并保留区间左右端限制', async () => {
    const w = await viewsWorld(database().db, 'f255-range-widen');
    const ids = new Map<number, string>();
    for (const day of [30, 45, 60, 61]) ids.set(day, await w.seedPartTime({ endDate: dateAt(w.today, day) }));
    const path = listPath(
      'expiring',
      1,
      { endFrom: dateAt(w.today, 40), endTo: dateAt(w.today, 60) },
      30,
      undefined,
      w.today,
    );
    const result = await w.ok<ViewBody>(await w.get(path.replace('/api/tenant/employment', '')));
    expect(result.total).toBe(2);
    expect(w.idsOf(result).sort()).toEqual([ids.get(45), ids.get(60)].sort());
  });

  it('当天区间使用最小窗口，365 天端点可查；无显式右端仍用默认 30 天', async () => {
    const w = await viewsWorld(database().db, 'f255-range-boundary');
    const ids = new Map<number, string>();
    for (const day of [0, 1, 30, 365, 366]) ids.set(day, await w.seedPartTime({ endDate: dateAt(w.today, day) }));
    for (const [end, expectedDays, expected] of [
      [w.today, '1', [0]],
      [dateAt(w.today, 365), '365', [0, 1, 30, 365]],
      [undefined, '30', [0, 1, 30]],
    ] as const) {
      const path = listPath('expiring', 1, { endFrom: w.today, endTo: end }, 30, undefined, w.today);
      expect(new URL(path, 'https://example.com').searchParams.get('days')).toBe(expectedDays);
      const result = await w.ok<ViewBody>(await w.get(path.replace('/api/tenant/employment', '')));
      expect(w.idsOf(result).sort()).toEqual(expected.map((day) => ids.get(day)).sort());
    }
  });
});
