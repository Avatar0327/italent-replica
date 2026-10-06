import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
const database = useTestDb();

it('AC-EST-13 / 需取证 #78 多方案时不自行决定分配，也不写入部分调编', async () => {
  const w = await carriedWorld(database().db, 'carried-ambiguous-schemes');
  const response = await w.write('establishment/schemes', {
    name: '合成第二方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
  });
  expect(response.status).toBe(201);
  const scheme = (await response.json()) as { id: string };
  for (const orgId of [w.from.id, w.to.id])
    expect(
      (
        await w.write('establishment/capacities', {
          orgId,
          schemeId: scheme.id,
          periodStart: '2026-01-01',
          localCapacity: 5,
        })
      ).status,
    ).toBe(201);
  const before = await w.capacities();
  const blocked = await w.save(await w.hired());
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_SCHEME_AMBIGUOUS' } } });
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual([]);
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
