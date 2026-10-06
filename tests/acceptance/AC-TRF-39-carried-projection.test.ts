import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
const database = useTestDb();

describe('AC-TRF-39 / DEC-173、195 带编在途投影与同日顺序', () => {
  it('已物化的未来直接调动到期复查不把自身误当成调出任职', async () => {
    const w = await carriedWorld(database().db, 'carried-direct-recheck');
    const response = await w.save(await w.hired());
    expect(response.status).toBe(201);
    const business = (await response.json()) as { id: string };
    const before = await w.capacities();
    expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    expect(await w.capacities()).toEqual(before);
    expect(await w.history()).toHaveLength(2);
    expect(await w.business(business.id)).toMatchObject({ effectiveDate: '2026-10-08' });
  });

  it('增加的编制进入未来峰值：同期间普通调入不能复用已转移给本单的额度', async () => {
    const w = await carriedWorld(database().db, 'carried-peak');
    expect((await w.save(await w.hired('带编员工'))).status).toBe(201);
    const response = await w.save(await w.hired('普通调动'), { withEstablishment: false, effectiveDate: '2026-10-03' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await w.history()).toHaveLength(2);
  });
});

it.each([false, true])('DEC-195 两笔迟到带编调动按原计划日、操作序号排序（同计划日=%s）', async (sameDay) => {
  const w = await carriedWorld(database().db, `carried-order-${sameDay}`);
  const person = await w.hired();
  const saved = [];
  for (const effectiveDate of [sameDay ? '2026-10-05' : '2026-10-07', '2026-10-05']) {
    const response = await w.save(person, { mode: 'application', submit: true, effectiveDate });
    expect(response.status, await response.clone().text()).toBe(201);
    saved.push((await response.json()) as { id: string });
  }
  for (const business of saved) await w.approve(business, '2026-10-02T01:00:00Z');
  const expected = (sameDay ? saved : [...saved].reverse()).map((row) => row.id);
  expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ activated: expected, failed: [], errors: [] });
  const records = await w.session.records(person.employee.id, '2026-10-08');
  expect(records.filter((row) => row.kind === 'transfer').map((row) => row.id)).toEqual(expected);
  expect(await w.runScheduler('2026-10-08T02:00:00Z')).toMatchObject({ activated: [] });
});

it('DEC-186 迟到跨年：原周期反向调整，实际执行日所属周期增减', async () => {
  const w = await carriedWorld(database().db, 'carried-cross-year');
  const nextCapacities: string[] = [];
  for (const [orgId, positionId, localCapacity] of [
    [w.from.id, w.sourcePosition, 2],
    [w.to.id, w.targetPosition, 0],
  ] as const) {
    const response = await w.write('establishment/capacities', {
      orgId,
      schemeId: w.scheme.id,
      periodStart: '2027-01-01',
      effectiveDate: '2026-10-01',
      strictControl: true,
      subdivisions: [{ positionId, localCapacity, inclusiveCapacity: null }],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    nextCapacities.push(((await response.json()) as { id: string }).id);
  }
  const response = await w.save(await w.hired(), { mode: 'application', submit: true, effectiveDate: '2026-12-31' });
  expect(response.status, await response.clone().text()).toBe(201);
  const business = (await response.json()) as { id: string };
  await w.approve(business, '2026-10-02T01:00:00Z');
  expect(await w.runScheduler('2027-01-02T01:00:00Z')).toMatchObject({
    activated: [business.id],
    failed: [],
    errors: [],
  });
  const { withTenant } = await import('@italent/db');
  const { readCapacity } = await import('../../apps/api/src/modules/establishment/capacity-read.js');
  const capacities = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    Promise.all(
      [w.sourceCapacity, w.targetCapacity, ...nextCapacities].map((id) =>
        readCapacity(tx, w.session.tenant.id, id, '2027-01-02'),
      ),
    ),
  );
  expect(capacities.map((row) => row.localCapacity)).toEqual([3, 0, 1, 1]);
  expect(await w.history()).toHaveLength(6);
});
