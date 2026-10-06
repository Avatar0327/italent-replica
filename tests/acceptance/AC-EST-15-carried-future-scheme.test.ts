import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
const database = useTestDb();

it('AC-EST-15 尚未生效的另一方案及容量不干扰当前有效的唯一成对方案', async () => {
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
    expect(capacity.status, await capacity.clone().text()).toBe(201);
  }
  const saved = await w.save(await w.hired());
  expect(saved.status, await saved.clone().text()).toBe(201);
  expect((await w.capacities()).map((c) => c.localCapacity)).toEqual([2, 1]);
  expect(await w.history()).toHaveLength(2);
});
