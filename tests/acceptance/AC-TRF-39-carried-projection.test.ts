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
