import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession } from './AC-EST-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-EST-04 编制必须满足父子及兄弟分配约束', () => {
  it('B本级3、含下级62，B1=10/B2=20时，B3=30拒绝而29允许', async () => {
    const session = await establishmentSession(testDb().db, 'est04');
    const parent = await session.create('B');
    const children = await Promise.all(
      ['B1', 'B2', 'B3'].map((name) => session.create(name, { parents: { admin: { parentId: parent.id } } })),
    );
    const scheme = await session.scheme({ maintenanceMode: 'both' });
    await session.capacity(parent.id, scheme.id, { localCapacity: 3, inclusiveCapacity: 62 });
    await session.capacity(children[0]!.id, scheme.id, { localCapacity: 0, inclusiveCapacity: 10 });
    await session.capacity(children[1]!.id, scheme.id, { localCapacity: 0, inclusiveCapacity: 20 });

    const denied = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: {
        orgId: children[2]!.id,
        schemeId: scheme.id,
        periodStart: '2026-01-01',
        localCapacity: 0,
        inclusiveCapacity: 30,
        strictControl: false,
      },
    });
    expect(denied.status).toBe(400);
    expect(await errorCode(denied)).toBe('VALIDATION_FAILED');
    expect(await session.capacities({ orgId: children[2]!.id })).toEqual([]);

    const allowed = await session.capacity(children[2]!.id, scheme.id, {
      localCapacity: 0,
      inclusiveCapacity: 29,
    });
    expect(allowed.inclusiveCapacity).toBe(29);
  });
});
