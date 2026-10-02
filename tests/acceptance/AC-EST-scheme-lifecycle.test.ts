import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST 被引用编制方案的生命周期', () => {
  it('已引用方案不可改周期/起始月/细分维度或删除，当前和未来引用均阻止停用', async () => {
    const session = await establishmentSession(testDb().db, 'est-scheme-locked');
    const org = await session.create('引用方案部门');
    const scheme = await session.scheme();
    await session.capacity(org.id, scheme.id);
    await session.capacity(org.id, scheme.id, { periodStart: '2027-01-01' });
    for (const patch of [{ periodType: 'monthly' }, { startMonth: 2 }, { subdivision: 'position' }]) {
      const denied = await session.request('PATCH', `/schemes/${scheme.id}`, {
        ifMatch: scheme.revision,
        body: { effectiveDate: '2026-10-01', ...patch },
      });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({
        error: { code: 'CONFLICT', details: { reason: 'SCHEME_REFERENCED' } },
      });
    }
    const deletion = await session.request('DELETE', `/schemes/${scheme.id}`, { ifMatch: scheme.revision });
    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toMatchObject({ error: { details: { reason: 'SCHEME_REFERENCED' } } });
    const disabled = await session.request('PATCH', `/schemes/${scheme.id}`, {
      ifMatch: scheme.revision,
      body: { effectiveDate: '2026-10-01', enabled: false },
    });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: { details: { reason: 'SCHEME_IN_USE' } } });
  });

  it('仅被历史周期引用的方案可停用，历史编制仍能读取', async () => {
    const session = await establishmentSession(testDb().db, 'est-scheme-history');
    const org = await session.create('历史方案部门', { startDate: '2025-01-01' });
    const scheme = await session.scheme({ startDate: '2025-01-01' });
    const historical = await session.capacity(org.id, scheme.id, { periodStart: '2025-01-01' });
    const disabled = await session.request('PATCH', `/schemes/${scheme.id}`, {
      ifMatch: scheme.revision,
      body: { effectiveDate: '2026-10-01', enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: false });
    expect(await session.capacities({ orgId: org.id, asOf: '2025-12-31' })).toContainEqual(
      expect.objectContaining({ id: historical.id, localCapacity: 10 }),
    );
  });

  it('当前和未来周期已引用时，缩短方案失效日同样拒绝，不能绕过停用限制', async () => {
    const session = await establishmentSession(testDb().db, 'est-scheme-expiry');
    const org = await session.create('失效日保护部门');
    const scheme = await session.scheme();
    await session.capacity(org.id, scheme.id);
    await session.capacity(org.id, scheme.id, { periodStart: '2027-01-01' });
    const stopped = await session.request('PATCH', `/schemes/${scheme.id}`, {
      ifMatch: scheme.revision,
      body: { effectiveDate: '2026-10-01', stopDate: '2026-10-01' },
    });
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toMatchObject({ error: { details: { reason: 'SCHEME_IN_USE' } } });
  });

  it('方案已排定在下一年停用，新建下期编制不能借当前仍启用的版本放行', async () => {
    const session = await establishmentSession(testDb().db, 'est-scheme-future-disabled');
    const org = await session.create('未来停用保护部门');
    const scheme = await session.scheme();
    const disabled = await session.request('PATCH', `/schemes/${scheme.id}`, {
      ifMatch: scheme.revision,
      body: { effectiveDate: '2027-01-01', enabled: false },
    });
    expect(disabled.status).toBe(200);
    const invalid = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: {
        orgId: org.id,
        schemeId: scheme.id,
        periodStart: '2027-01-01',
        effectiveDate: '2026-10-01',
        localCapacity: 10,
      },
    });
    expect(invalid.status).toBe(400);
    expect(await session.capacities({ orgId: org.id, periodStart: '2027-01-01' })).toEqual([]);
  });
});
