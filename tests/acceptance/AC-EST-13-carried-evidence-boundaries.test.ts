import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
const database = useTestDb();

// F-484（DEC-295①）：同组织同期间不能再有第二个方案的编制，“多方案并存”在写入侧被拒，不会走到分配歧义
it('AC-EST-13 / 需取证 #78 第二方案的重叠编制被拒绝，库内不出现多方案并存，调动按唯一方案成对分配', async () => {
  const w = await carriedWorld(database().db, 'carried-ambiguous-schemes');
  const response = await w.write('establishment/schemes', {
    name: '合成第二方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
  });
  expect(response.status).toBe(201);
  const scheme = (await response.json()) as { id: string };
  const before = await w.capacities();
  for (const orgId of [w.from.id, w.to.id]) {
    const rejected = await w.write('establishment/capacities', {
      orgId,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      localCapacity: 5,
    });
    expect(rejected.status, await rejected.clone().text()).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'CAPACITY_PERIOD_OVERLAP' } } });
  }
  expect(await w.capacities()).toEqual(before);
  const saved = await w.save(await w.hired());
  expect(saved.status, await saved.clone().text()).toBe(201);
  expect((await w.capacities()).map((c) => c.localCapacity)).toEqual([2, 1]);
});

it('AC-EST-13 / 需取证 #78 无调入细分时不自行新建或转入预留', async () => {
  const w = await carriedWorld(database().db, 'carried-unmatched-target');
  const before = await w.capacities();
  const response = await w.save(await w.hired(), { fields: { departmentId: w.to.id, positionId: null } });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { details: { reason: 'ESTABLISHMENT_TARGET_SUBDIVISION_REQUIRED' } },
  });
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual([]);
});
