import { randomUUID } from 'node:crypto';
import { type Db, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type {
  EstablishmentPersonnelPort,
  HeadcountQuery,
  VerifiedTransfer,
} from '../../apps/api/src/modules/establishment/personnel.js';
import { applyTransferStage } from '../../apps/api/src/modules/establishment/transfer-service.js';
import { EST_NOW, establishmentSession, type EstablishmentSession } from './AC-EST-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

function trustedPort(
  session: EstablishmentSession,
  transfers: readonly VerifiedTransfer[],
  count: (query: HeadcountQuery) => number,
): EstablishmentPersonnelPort {
  return {
    readTransfer: vi.fn(async (_tx, query) => {
      expect(query.tenantId).toBe(session.tenant.id);
      const transfer = transfers.find((item) => item.businessId === query.businessId);
      if (!transfer) throw new Error('合成可信业务单不存在');
      return transfer;
    }),
    headcount: vi.fn(async (_tx, query) => {
      expect(query.tenantId).toBe(session.tenant.id);
      return count(query);
    }),
    applyTransfer: vi.fn(async () => undefined),
  };
}

function transfer(sourceOrgId: string, targetOrgId: string, effectiveDate = '2026-10-02'): VerifiedTransfer {
  return { businessId: randomUUID(), employeeId: randomUUID(), sourceOrgId, targetOrgId, effectiveDate };
}

async function submit(db: Db, session: EstablishmentSession, businessId: string, port: EstablishmentPersonnelPort) {
  return withTenant(db, session.tenant.id, (tx) =>
    applyTransferStage(
      tx,
      {
        tenantId: session.tenant.id,
        userId: session.user.id,
        timezone: session.tenant.timezone,
        now: EST_NOW,
        expectedRevision: 0,
        commandId: randomUUID(),
      },
      { businessId, stage: 'submitted', confirmed: true },
      port,
    ),
  );
}

async function timings(session: EstablishmentSession, transferOut: 'submitted' | 'approved' = 'submitted') {
  const response = await session.request('PUT', '/settings', {
    ifMatch: 0,
    body: { transferIn: 'submitted', transferOut },
  });
  expect(response.status).toBe(200);
}

async function childPosition(db: Db, session: EstablishmentSession, orgId: string) {
  const api = tenantApi(db);
  const post = await api.request('POST', '/api/tenant/job/posts', {
    user: session.user.id,
    tenant: session.tenant.id,
    ifMatch: 0,
    body: { name: '范围验收职务', code: `POST-${randomUUID()}`, startDate: '2026-01-01' },
  });
  expect(post.status).toBe(201);
  const postId = ((await post.json()) as { id: string }).id;
  const position = await api.request('POST', '/api/tenant/job/positions', {
    user: session.user.id,
    tenant: session.tenant.id,
    ifMatch: 0,
    body: { name: '范围验收职位', code: `POS-${randomUUID()}`, orgId, postId, startDate: '2026-01-01' },
  });
  expect(position.status).toBe(201);
  return ((await position.json()) as { id: string }).id;
}

describe('AC-EST-01/03/04 编制范围、占用时机与关联时间轴', () => {
  it('调入提交占用、调出审批释放时，共同上级不能提前抵扣尚未释放的人数', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-mixed-timing');
    const parent = await session.create('共同上级');
    const source = await session.create('内部调出', { parents: { admin: { parentId: parent.id } } });
    const target = await session.create('内部调入', { parents: { admin: { parentId: parent.id } } });
    const scheme = await session.scheme({ maintenanceMode: 'both' });
    await session.capacity(parent.id, scheme.id, { localCapacity: 0, inclusiveCapacity: 10, strictControl: true });
    await timings(session, 'approved');
    const business = transfer(source.id, target.id);
    const port = trustedPort(session, [business], (query) => (query.includeDescendants ? 10 : 0));

    await expect(submit(db, session, business.businessId, port)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ESTABLISHMENT_EXCEEDED' },
    });
    expect(port.applyTransfer).not.toHaveBeenCalled();
  });

  it('未来改隶后的行政范围计入已预占单，严格含下级编制1拒绝第二次调入', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-future-scope');
    const parent = await session.create('未来接收上级');
    const source = await session.create('范围外调出');
    const target = await session.create('未来改隶部门');
    const api = tenantApi(db);
    const reparent = await api.request('PATCH', `/api/tenant/org/organizations/${target.id}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: target.revision,
      body: { effectiveDate: '2027-01-01', parents: { admin: { parentId: parent.id } } },
    });
    expect(reparent.status).toBe(200);
    const scheme = await session.scheme({ maintenanceMode: 'inclusive' });
    await session.capacity(parent.id, scheme.id, {
      periodStart: '2027-01-01',
      localCapacity: null,
      inclusiveCapacity: 1,
      strictControl: true,
    });
    await timings(session);
    const first = transfer(source.id, target.id, '2027-01-02');
    const second = transfer(source.id, target.id, '2027-01-02');
    const port = trustedPort(session, [first, second], () => 0);
    expect(await submit(db, session, first.businessId, port)).toMatchObject({ status: 'submitted', reserveIn: true });

    await expect(submit(db, session, second.businessId, port)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ESTABLISHMENT_EXCEEDED' },
    });
    expect(port.applyTransfer).not.toHaveBeenCalled();
  });

  it('祖先按职位细分的本级0不限制子部门调入，含下级10仍有1个余额', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-position-ancestor');
    const parent = await session.create('职位细分上级');
    const source = await session.create('职位范围外调出');
    const target = await session.create('职位所属子部门', { parents: { admin: { parentId: parent.id } } });
    const positionId = await childPosition(db, session, target.id);
    const scheme = await session.scheme({ maintenanceMode: 'both', subdivision: 'position' });
    await session.capacity(parent.id, scheme.id, {
      localCapacity: 0,
      inclusiveCapacity: 10,
      subdivisions: [{ positionId, localCapacity: 0, inclusiveCapacity: 10 }],
      strictControl: true,
    });
    await timings(session);
    const business = { ...transfer(source.id, target.id), targetPositionId: positionId };
    const port = trustedPort(session, [business], (query) => (query.includeDescendants ? 9 : 0));

    expect(await submit(db, session, business.businessId, port)).toMatchObject({
      status: 'submitted',
      reserveIn: true,
      warnings: [],
    });
    expect(port.applyTransfer).not.toHaveBeenCalled();
  });

  it('同步上级遇到上级后续版本须409，子级与上级所有历史值及revision保持不变', async () => {
    const session = await establishmentSession(testDb().db, 'est-sync-future-parent');
    const parent = await session.create('有后续版本上级');
    const child = await session.create('同步下级', { parents: { admin: { parentId: parent.id } } });
    const scheme = await session.scheme({ maintenanceMode: 'both' });
    const parentCapacity = await session.capacity(parent.id, scheme.id, { localCapacity: 0, inclusiveCapacity: 10 });
    const childCapacity = await session.capacity(child.id, scheme.id, { localCapacity: 0, inclusiveCapacity: 1 });
    const future = await session.request('PATCH', `/capacities/${parentCapacity.id}`, {
      ifMatch: parentCapacity.revision,
      body: { effectiveDate: '2026-08-01', inclusiveCapacity: 11 },
    });
    expect(future.status).toBe(200);
    const changed = await session.request('PATCH', `/capacities/${childCapacity.id}`, {
      ifMatch: childCapacity.revision,
      body: { effectiveDate: '2026-06-01', inclusiveCapacity: 2, syncParents: true },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: 'EST_FUTURE_VERSION_EXISTS' } });
    expect(await session.capacities({ orgId: child.id, asOf: '2026-06-01' })).toContainEqual(
      expect.objectContaining({ id: childCapacity.id, revision: 1, inclusiveCapacity: 1 }),
    );
    expect(await session.capacities({ orgId: parent.id, asOf: '2026-06-01' })).toContainEqual(
      expect.objectContaining({ id: parentCapacity.id, revision: 2, inclusiveCapacity: 10 }),
    );
    expect(await session.capacities({ orgId: parent.id, asOf: '2026-08-01' })).toContainEqual(
      expect.objectContaining({ id: parentCapacity.id, revision: 2, inclusiveCapacity: 11 }),
    );
  });
});
