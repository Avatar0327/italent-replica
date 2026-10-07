import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
const database = useTestDb();

describe('AC-TRF-48 带编调动沿已有撤销/删除路径反向调整', () => {
  it.each(['delete', 'revoke', 'withdraw'])('%s 恢复原细分与预留，重复命令不重复回退', async (action) => {
    const w = await carriedWorld(database().db, `carried-${action}`, { matched: false });
    const before = await w.capacities();
    const response = await w.save(await w.hired(), action === 'delete' ? {} : { mode: 'application', submit: true });
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string; revision: number };
    const execute = () =>
      w.session.request(
        action === 'delete' ? 'DELETE' : 'POST',
        `/businesses/${business.id}${action === 'delete' ? '' : `/${action}`}`,
        {
          ifMatch: business.revision,
          idempotencyKey: `carried-${action}`,
          body: {},
        },
      );
    const removed = await execute();
    expect(removed.status, await removed.clone().text()).toBe(200);
    const after = await w.capacities();
    for (let i = 0; i < before.length; i++)
      expect(after[i]).toMatchObject({
        localCapacity: before[i]!.localCapacity,
        reservedLocal: before[i]!.reservedLocal,
        subdivisions: before[i]!.subdivisions,
      });
    expect(await w.history()).toHaveLength(4);
    expect((await execute()).status).toBe(200);
    expect(await w.history()).toHaveLength(4);
    if (action === 'withdraw') {
      const current = await w.business(business.id);
      const resubmitted = await w.session.request('POST', `/businesses/${business.id}/submit`, {
        ifMatch: current.revision,
        body: {},
      });
      expect(resubmitted.status, await resubmitted.clone().text()).toBe(200);
      expect((await w.capacities())[1]).toMatchObject({ localCapacity: 1 });
      expect(await w.history()).toHaveLength(6);
    }
  });
});

it('已转入的额度被其他员工占用：回退严格超编时，业务、容量与审计整体保持原状', async () => {
  const w = await carriedWorld(database().db, 'carried-consumed');
  const response = await w.save(await w.hired());
  expect(response.status).toBe(201);
  const business = (await response.json()) as { id: string; revision: number };
  const occupant = await w.session.employee('合成后来占编员工');
  await w.session.business(
    occupant.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-10-01',
      fields: { departmentId: w.to.id, positionId: w.targetPosition },
    },
    occupant.revision,
  );
  const before = await w.capacities();
  const history = await w.history();
  const result = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: business.revision });
  expect(result.status, await result.clone().text()).toBe(409);
  expect(await result.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual(history);
  expect(await w.business(business.id)).toMatchObject({ status: 'effective' });
});
