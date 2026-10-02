import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession, type EstablishmentSession } from './AC-EST-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function position(db: Db, session: EstablishmentSession, orgId: string) {
  const api = tenantApi(db);
  const request = (kind: string, body: unknown) =>
    api.request('POST', `/api/tenant/job/${kind}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: 0,
      body,
    });
  const post = await request('posts', {
    name: '编制维度职务',
    code: `POST-${randomUUID()}`,
    startDate: '2026-01-01',
  });
  expect(post.status).toBe(201);
  const postId = ((await post.json()) as { id: string }).id;
  const created = await request('positions', {
    name: '编制维度职位',
    code: `POSITION-${randomUUID()}`,
    orgId,
    postId,
    startDate: '2026-01-01',
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

describe('AC-EST 编制维护方式与四条一致性约束', () => {
  it('只维护本级时含下级自动汇总真实行政子组织，不能手工输入含下级', async () => {
    const session = await establishmentSession(testDb().db, 'est-local');
    const parent = await session.create('自动汇总上级');
    const child = await session.create('自动汇总下级', { parents: { admin: { parentId: parent.id } } });
    const other = await session.create('违规手填部门');
    const scheme = await session.scheme();
    await session.capacity(parent.id, scheme.id, { localCapacity: 3 });
    await session.capacity(child.id, scheme.id, { localCapacity: 10 });
    expect(await session.capacities({ orgId: parent.id })).toContainEqual(
      expect.objectContaining({ localCapacity: 3, inclusiveCapacity: 13 }),
    );
    const rejected = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: { orgId: other.id, schemeId: scheme.id, periodStart: '2026-01-01', localCapacity: 1, inclusiveCapacity: 1 },
    });
    expect(rejected.status).toBe(400);
    expect(await session.capacities({ orgId: other.id })).toEqual([]);
  });

  it('只维护含下级时本级始终为空，不能填写本级数字', async () => {
    const session = await establishmentSession(testDb().db, 'est-inclusive');
    const org = await session.create('仅含下级部门');
    const scheme = await session.scheme({ maintenanceMode: 'inclusive' });
    const saved = await session.capacity(org.id, scheme.id, { localCapacity: null, inclusiveCapacity: 12 });
    expect(saved).toMatchObject({ localCapacity: null, inclusiveCapacity: 12 });
    const invalid = await session.request('PATCH', `/capacities/${saved.id}`, {
      ifMatch: saved.revision,
      body: { effectiveDate: '2026-02-01', localCapacity: 1 },
    });
    expect(invalid.status).toBe(400);
  });

  it('分别维护时含下级小于本级拒绝，新增下级也不能突破父级扣除本级后的余额', async () => {
    const session = await establishmentSession(testDb().db, 'est-consistency');
    const parent = await session.create('配额约束上级');
    const child = await session.create('配额约束下级', { parents: { admin: { parentId: parent.id } } });
    const scheme = await session.scheme({ maintenanceMode: 'both' });
    const invalidParent = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: {
        orgId: parent.id,
        schemeId: scheme.id,
        periodStart: '2026-01-01',
        localCapacity: 10,
        inclusiveCapacity: 9,
      },
    });
    expect(invalidParent.status).toBe(400);
    await session.capacity(parent.id, scheme.id, { localCapacity: 10, inclusiveCapacity: 15 });
    const invalidChild = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: { orgId: child.id, schemeId: scheme.id, periodStart: '2026-01-01', localCapacity: 1, inclusiveCapacity: 6 },
    });
    expect(invalidChild.status).toBe(400);
    expect(await session.capacities({ orgId: child.id })).toEqual([]);
  });

  it('按职位细分时总量由细分和预留自动计算，禁止手填小于细分之和的总量', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-subdivision');
    const org = await session.create('职位细分部门');
    const positionId = await position(db, session, org.id);
    const scheme = await session.scheme({ subdivision: 'position', maintenanceMode: 'both' });
    const subdivisions = [{ positionId, localCapacity: 7, inclusiveCapacity: 9 }];
    const manual = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: {
        orgId: org.id,
        schemeId: scheme.id,
        periodStart: '2026-01-01',
        localCapacity: 1,
        inclusiveCapacity: 2,
        subdivisions,
      },
    });
    expect(manual.status).toBe(400);
    const automatic = await session.request('POST', '/capacities', {
      ifMatch: 0,
      body: {
        orgId: org.id,
        schemeId: scheme.id,
        periodStart: '2026-01-01',
        reservedLocal: 2,
        reservedInclusive: 3,
        subdivisions,
      },
    });
    expect(automatic.status).toBe(201);
    const original = (await automatic.json()) as { id: string; revision: number };
    expect(original).toMatchObject({ localCapacity: 9, inclusiveCapacity: 12 });
    const adjusted = await session.request('PATCH', `/capacities/${original.id}`, {
      ifMatch: original.revision,
      body: {
        effectiveDate: '2026-02-01',
        subdivisions: [{ positionId, localCapacity: 8, inclusiveCapacity: 10 }],
      },
    });
    expect(adjusted.status).toBe(200);
    expect(await adjusted.json()).toMatchObject({ localCapacity: 10, inclusiveCapacity: 13 });
  });
});
