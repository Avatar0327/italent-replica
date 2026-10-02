import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-05 月度编制按差值传播到明确选择的范围', () => {
  it.each(['2026-03-01', '2026-01-01'])('1月1→4，调整范围截止%s，范围外保持原值', async (through) => {
    const session = await establishmentSession(testDb().db, `est05-${through}`);
    const department = await session.create('月度调整部门');
    const scheme = await session.scheme({ periodType: 'monthly' });
    const original = [];
    // 逆序创建，避免新建的自动带出覆盖本例明确维护的1/2/3/7。
    for (const [periodStart, localCapacity] of [
      ['2026-04-01', 7],
      ['2026-03-01', 3],
      ['2026-02-01', 2],
      ['2026-01-01', 1],
    ] as const) {
      original.push(await session.capacity(department.id, scheme.id, { periodStart, localCapacity }));
    }
    const january = original.find((item) => item.periodStart === '2026-01-01')!;
    const adjusted = await session.request('PATCH', `/capacities/${january.id}`, {
      ifMatch: january.revision,
      body: { effectiveDate: '2026-01-01', localCapacity: 4, adjustmentThrough: through },
    });
    expect(adjusted.status).toBe(200);

    const rows = await session.capacities({ orgId: department.id, asOf: '2026-10-01' });
    const capacities = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map(
      (period) => rows.find((item) => item.periodStart === period)?.localCapacity,
    );
    expect(capacities).toEqual(through === '2026-03-01' ? [4, 5, 6, 7] : [4, 2, 3, 7]);
  });
});
