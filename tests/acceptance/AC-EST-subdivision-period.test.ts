import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession, type Capacity, type EstablishmentSession } from './AC-EST-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
type SubdividedCapacity = Capacity & {
  reservedLocal: number;
  reservedInclusive: number;
  subdivisions: { positionId: string; localCapacity: number | null; inclusiveCapacity: number | null }[];
};

async function position(db: Db, session: EstablishmentSession, orgId: string, label: string) {
  const api = tenantApi(db);
  const write = (kind: string, body: unknown) =>
    api.request('POST', `/api/tenant/job/${kind}`, {
      tenant: session.tenant.id,
      user: session.user.id,
      ifMatch: 0,
      body,
    });
  const post = await write('posts', { name: '周期细分职务', code: `POST-${randomUUID()}`, startDate: '2026-01-01' });
  expect(post.status).toBe(201);
  const created = await write('positions', {
    name: `周期细分职位${label}`,
    code: `POSITION-${randomUUID()}`,
    postId: ((await post.json()) as { id: string }).id,
    orgId,
    startDate: '2026-01-01',
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

describe('AC-EST-05 选定周期同步职位细分和预留差值（18§4）', () => {
  it.each(['2026-01-01', '2026-04-01'])('新增与调整的职位细分、预留只传播至%s，范围外保持原值', async (through) => {
    const { db } = testDb();
    const session = await establishmentSession(db, `est-part-period-${through}`);
    const parent = await session.create('周期细分上级');
    const department = await session.create('周期细分部门', { parents: { admin: { parentId: parent.id } } });
    const firstPosition = await position(db, session, department.id, '原有');
    const addedPosition = await position(db, session, department.id, '新增');
    const scheme = await session.scheme({
      periodType: 'quarterly',
      subdivision: 'position',
      maintenanceMode: 'both',
    });
    const create = (
      periodStart: string,
      local: number,
      inclusive: number,
      reserveLocal: number,
      reserveInclusive: number,
    ) =>
      session.capacity(department.id, scheme.id, {
        periodStart,
        localCapacity: undefined,
        subdivisions: [{ positionId: firstPosition, localCapacity: local, inclusiveCapacity: inclusive }],
        reservedLocal: reserveLocal,
        reservedInclusive: reserveInclusive,
      });
    for (const periodStart of ['2026-01-01', '2026-04-01', '2026-07-01'])
      await session.capacity(parent.id, scheme.id, {
        periodStart,
        localCapacity: undefined,
        reservedInclusive: 20,
        subdivisions: [{ positionId: firstPosition, localCapacity: 0, inclusiveCapacity: 50 }],
      });
    await create('2026-07-01', 9, 15, 6, 7);
    await create('2026-04-01', 8, 12, 4, 5);
    const first = await create('2026-01-01', 7, 9, 2, 3);
    const response = await session.request('PATCH', `/capacities/${first.id}`, {
      ifMatch: first.revision,
      body: {
        effectiveDate: '2026-01-01',
        adjustmentThrough: through,
        syncParents: true,
        reservedLocal: 3,
        reservedInclusive: 5,
        subdivisions: [
          { positionId: firstPosition, localCapacity: 8, inclusiveCapacity: 11 },
          { positionId: addedPosition, localCapacity: 2, inclusiveCapacity: 3 },
        ],
      },
    });
    expect(response.status).toBe(200);
    const capacities = (await session.capacities({ orgId: department.id })) as SubdividedCapacity[];
    verifyChild(capacities, through, firstPosition, addedPosition);
    const ancestors = (await session.capacities({ orgId: parent.id })) as SubdividedCapacity[];
    expect(ancestors.map((row) => [row.periodStart, row.inclusiveCapacity])).toEqual([
      ['2026-01-01', 77],
      ['2026-04-01', through === '2026-04-01' ? 77 : 70],
      ['2026-07-01', 70],
    ]);
    const changedParent = ancestors.find((row) => row.periodStart === '2026-01-01')!;
    expect(changedParent).toMatchObject({ localCapacity: 0, reservedLocal: 0, reservedInclusive: 22 });
    expect(changedParent.subdivisions).toEqual(
      expect.arrayContaining([
        { positionId: firstPosition, localCapacity: 0, inclusiveCapacity: 52 },
        { positionId: addedPosition, localCapacity: 0, inclusiveCapacity: 3 },
      ]),
    );
  });
});

function verifyChild(
  capacities: SubdividedCapacity[],
  through: string,
  firstPosition: string,
  addedPosition: string,
): void {
  const january = capacities.find((row) => row.periodStart === '2026-01-01')!;
  expect(january).toMatchObject({
    localCapacity: 13,
    inclusiveCapacity: 19,
    reservedLocal: 3,
    reservedInclusive: 5,
  });
  const april = capacities.find((row) => row.periodStart === '2026-04-01')!;
  if (through === '2026-04-01') {
    expect(april).toMatchObject({
      localCapacity: 16,
      inclusiveCapacity: 24,
      reservedLocal: 5,
      reservedInclusive: 7,
    });
    expect(april.subdivisions).toEqual(
      expect.arrayContaining([
        { positionId: firstPosition, localCapacity: 9, inclusiveCapacity: 14 },
        { positionId: addedPosition, localCapacity: 2, inclusiveCapacity: 3 },
      ]),
    );
    expect(april.subdivisions).toHaveLength(2);
  } else {
    expect(april).toMatchObject({
      localCapacity: 12,
      inclusiveCapacity: 17,
      reservedLocal: 4,
      reservedInclusive: 5,
    });
    expect(april.subdivisions).toEqual([{ positionId: firstPosition, localCapacity: 8, inclusiveCapacity: 12 }]);
  }
  const july = capacities.find((row) => row.periodStart === '2026-07-01')!;
  expect(july).toMatchObject({ localCapacity: 15, inclusiveCapacity: 22, reservedLocal: 6, reservedInclusive: 7 });
  expect(july.subdivisions).toEqual([{ positionId: firstPosition, localCapacity: 9, inclusiveCapacity: 15 }]);
}
