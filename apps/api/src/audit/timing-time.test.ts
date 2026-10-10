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
