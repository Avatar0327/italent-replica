import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
const database = useTestDb();

describe('AC-TRF-38 带编调动沿已有撤销/删除路径反向调整', () => {
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
