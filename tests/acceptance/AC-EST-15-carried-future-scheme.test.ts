import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
const database = useTestDb();

// F-484（DEC-295①）：同组织同期间不能再建另一方案的编制（不论该方案或版本何时生效），调动只面对唯一方案
it('AC-EST-15 尚未生效的另一方案无法在同期间建编制，不干扰当前有效的唯一成对方案', async () => {
  const w = await carriedWorld(database().db, 'carried-future-scheme');
  const response = await w.write('establishment/schemes', {
    name: '合成未来方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-11-01',
  });
  expect(response.status).toBe(201);
  const scheme = (await response.json()) as { id: string };
  for (const orgId of [w.from.id, w.to.id]) {
    const capacity = await w.write('establishment/capacities', {
      orgId,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      effectiveDate: '2026-11-01',
      localCapacity: 5,
    });
    expect(capacity.status, await capacity.clone().text()).toBe(409);
    expect(await capacity.json()).toMatchObject({ error: { details: { reason: 'CAPACITY_PERIOD_OVERLAP' } } });
  }
  const saved = await w.save(await w.hired());
  expect(saved.status, await saved.clone().text()).toBe(201);
  expect((await w.capacities()).map((c) => c.localCapacity)).toEqual([2, 1]);
  expect(await w.history()).toHaveLength(2);
});
