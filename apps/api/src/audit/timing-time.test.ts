import { tenantLocalDate } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { disclosedOccurredAt, tenantDayStart } from './timing-time.js';

describe('AC-360-F060 计时审计的发生时间披露（DEC-405①）', () => {
  it('模糊到租户当地日的 00:00（含夏令时切换日）', () => {
    expect(tenantDayStart(new Date('2026-10-01T02:00:07.123Z'), 'Asia/Shanghai').toISOString()).toBe(
      '2026-09-30T16:00:00.000Z',
    );
    // 美东 2026-11-01 夏令时结束当天：当地 00:00 仍是 EDT（UTC-4）
    expect(tenantDayStart(new Date('2026-11-01T12:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(tenantDayStart(new Date('2026-11-01T23:30:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
  });

  it('当地零点不存在 / 重复的时区：取当地日第一个有效时刻（第 3 轮审查 P3）', () => {
    // 圣地亚哥 2026-09-06 夏令时从 00:00 直接跳到 01:00，当日没有 00:00；第一个有效时刻是 04:00Z（当地 01:00）
    expect(tenantDayStart(new Date('2026-09-06T12:00:00Z'), 'America/Santiago').toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
    // 哈瓦那 2026-11-01 夏令时结束，当地 00:00 出现两次（04:00Z 与 05:00Z）；取第一次
    expect(tenantDayStart(new Date('2026-11-01T12:00:00Z'), 'America/Havana').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    // 跳过的那一刻之前仍属前一天
    expect(tenantLocalDate(new Date('2026-09-06T03:59:59Z'), 'America/Santiago')).toBe('2026-09-05');
  });

  it('只模糊计时的建立 / 翻页事件；清除与其他对象的事件原样', () => {
    const at = new Date('2026-10-01T02:00:07.123Z');
    const timing = (action: string) => ({ objectType: 'survey360-sheet-timing', action, occurredAt: at });
    expect(disclosedOccurredAt(timing('survey360.sheet-timing.open'), 'Asia/Shanghai')).toBe(
      '2026-09-30T16:00:00.000Z',
    );
    expect(disclosedOccurredAt(timing('survey360.sheet-timing.page'), 'Asia/Shanghai')).toBe(
      '2026-09-30T16:00:00.000Z',
    );
    expect(disclosedOccurredAt(timing('survey360.sheet-timing.clear'), 'Asia/Shanghai')).toBe(at.toISOString());
    expect(
      disclosedOccurredAt(
        { objectType: 'survey360-sheet', action: 'survey360.sheet.submit', occurredAt: at },
        'Asia/Shanghai',
      ),
    ).toBe(at.toISOString());
  });
});
