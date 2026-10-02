import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-05 生效时间与明确选择的周期范围', () => {
  it('月度方案可以四月起始，周期仍按自然月而非强制从一月开始', async () => {
    const session = await establishmentSession(testDb().db, 'est-month-start');
    const department = await session.create('四月起始部门');
    const scheme = await session.scheme({ periodType: 'monthly', startMonth: 4 });
    const capacity = await session.capacity(department.id, scheme.id, { periodStart: '2026-04-01' });
    expect(capacity.periodStart).toBe('2026-04-01');
    const partialMonth = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: { orgId: department.id, schemeId: scheme.id, periodStart: '2026-05-02', localCapacity: 1 },
    });
    expect(partialMonth.status).toBe(400);
  });

  it('DEC-072 变更早于方案第一版时也返回409', async () => {
    const session = await establishmentSession(testDb().db, 'est-scheme-future');
    const scheme = await session.scheme({ startDate: '2027-01-01' });
    const response = await session.request('PATCH', `/schemes/${scheme.id}`, {
      ifMatch: scheme.revision,
      body: { name: '提前变更', effectiveDate: '2026-10-01' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'EST_FUTURE_VERSION_EXISTS' } });
  });

  it('DEC-072 变更早于组织编制第一版时也返回409', async () => {
    const session = await establishmentSession(testDb().db, 'est-capacity-future');
    const department = await session.create('未来编制部门');
    const scheme = await session.scheme();
    const future = await session.capacity(department.id, scheme.id, {
      periodStart: '2027-01-01',
      effectiveDate: '2027-01-01',
    });
    const response = await session.request('PATCH', `/capacities/${future.id}`, {
      ifMatch: future.revision,
      body: { localCapacity: 20, effectiveDate: '2026-10-01' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'EST_FUTURE_VERSION_EXISTS' } });
  });

  it('季度差值传播遵循显式选定的跨年范围，范围外周期不变', async () => {
    const session = await establishmentSession(testDb().db, 'est-quarter-scope');
    const department = await session.create('跨年季度部门');
    const scheme = await session.scheme({ periodType: 'quarterly' });
    await session.capacity(department.id, scheme.id, { periodStart: '2027-04-01', localCapacity: 9 });
    await session.capacity(department.id, scheme.id, { periodStart: '2027-01-01', localCapacity: 7 });
    const first = await session.capacity(department.id, scheme.id, { periodStart: '2026-10-01', localCapacity: 5 });
    const response = await session.request('PATCH', `/capacities/${first.id}`, {
      ifMatch: first.revision,
      body: { effectiveDate: '2026-10-01', localCapacity: 8, adjustmentThrough: '2027-01-01' },
    });
    expect(response.status).toBe(200);
    const all = await session.capacities({ orgId: department.id, asOf: '2027-04-01' });
    expect(all.map(({ periodStart, localCapacity }) => ({ periodStart, localCapacity }))).toEqual([
      { periodStart: '2026-10-01', localCapacity: 8 },
      { periodStart: '2027-01-01', localCapacity: 10 },
      { periodStart: '2027-04-01', localCapacity: 9 },
    ]);
  });
});
