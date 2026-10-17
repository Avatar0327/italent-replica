/**
 * AC-PT-03 任职状态按日期派生（docs/08_设计/R2-T05_兼职设计.md §1.2 / §9 PB-14～16、PB-27；PT-3a 服务层）：
 * 保存即落地，不等开始日、不靠定时任务；“未开始 / 兼职中 / 已结束”与“任职中 / 任职结束”读取时按租户今天从区间派生。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { serviceWorld } from './AC-PT-service-support.js';

const database = useTestDb();
const at = (day: string) => `${day}T01:00:00.000Z`;

describe('AC-PT-03 结束日次日起任职结束', () => {
  it('PB-27：结束日 = 10-31，今天 10-31 仍任职中，11-01 起任职结束；两次读取之间没有任何写入', async () => {
    const w = await serviceWorld(database().db, 'pt03-boundary');
    const onLastDay = await w.create(
      { startDate: '2026-10-01', endDate: '2026-10-31' },
      w.context(0, at('2026-10-31')),
    );
    expect(onLastDay).toMatchObject({ serviceStatus: 'serving', views: ['ongoing', 'expiring', 'all'] });
    const nextDay = await w.create({ startDate: '2026-10-01', endDate: '2026-10-31' }, w.context(0, at('2026-11-01')));
    expect(nextDay).toMatchObject({ serviceStatus: 'ended', views: ['ended', 'all'] });
    // 派生无定时任务：期限链只有各自的第 1 期
    expect(await w.terms(onLastDay.id)).toHaveLength(1);
  });

  it('PB-14：过去开始 + 过去结束 → 保存即“已结束”、任职状态“任职结束”（W-611）', async () => {
    const w = await serviceWorld(database().db, 'pt03-past');
    const created = await w.create({ startDate: '2026-08-01', endDate: '2026-08-31' });
    expect(created).toMatchObject({ serviceStatus: 'ended', views: ['ended', 'all'] });
  });

  it('PB-15：未来开始 → “未开始”，任职状态仍是“任职中”（W-612）', async () => {
    const w = await serviceWorld(database().db, 'pt03-future');
    const created = await w.create({ startDate: '2026-11-01', endDate: '2026-12-31' });
    expect(created).toMatchObject({ serviceStatus: 'serving', views: ['not_started', 'all'] });
  });

  it('PB-16：当天开始当天结束 → “兼职中”且“即将到期”（W-613）', async () => {
    const w = await serviceWorld(database().db, 'pt03-same-day');
    const created = await w.create({ startDate: '2026-10-01', endDate: '2026-10-01' });
    expect(created).toMatchObject({ serviceStatus: 'serving', views: ['ongoing', 'expiring', 'all'] });
  });
});
