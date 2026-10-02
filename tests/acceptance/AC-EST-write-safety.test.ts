import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resultRows } from './AC-ORG-support.js';
import { establishmentSession, type Capacity } from './AC-EST-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-EST 平台写入约定、版本历史与租户隔离', () => {
  it('编制新建必须有revision，重复命令仅一行、一次审计，异内容不能复用命令', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-idempotency');
    const org = await session.create('幂等编制部门');
    const scheme = await session.scheme();
    const body = { orgId: org.id, schemeId: scheme.id, periodStart: '2026-01-01', localCapacity: 10 };
    const missingRevision = await session.request('POST', '/capacities', { body });
    expect(missingRevision.status).toBe(400);
    expect(await errorCode(missingRevision)).toBe('REVISION_REQUIRED');
    const command = randomUUID();
    const first = await session.request('POST', '/capacities', { body, ifMatch: 0, idempotencyKey: command });
    expect(first.status).toBe(201);
    const saved = (await first.json()) as Capacity;
    const second = await session.request('POST', '/capacities', { body, ifMatch: 0, idempotencyKey: command });
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(saved);
    const changed = await session.request('POST', '/capacities', {
      body: { ...body, localCapacity: 11 },
      ifMatch: 0,
      idempotencyKey: command,
    });
    expect(changed.status).toBe(409);
    expect(await errorCode(changed)).toBe('IDEMPOTENCY_CONFLICT');
    expect(await session.capacities({ orgId: org.id })).toHaveLength(1);
    const audits = await withTenant(db, session.tenant.id, (tx) =>
      tx.execute(sql`SELECT object_id FROM audit_events
        WHERE command_id = ${command} AND action = 'establishment.capacity.create'`),
    );
    expect(resultRows(audits)).toHaveLength(1);
  });

  it('调整新增版本，历史时点仍保留原值，过期revision拒绝且不覆盖未来版本', async () => {
    const session = await establishmentSession(testDb().db, 'est-history');
    const org = await session.create('版本编制部门');
    const scheme = await session.scheme();
    const original = await session.capacity(org.id, scheme.id);
    const updated = await session.request('PATCH', `/capacities/${original.id}`, {
      ifMatch: original.revision,
      body: { effectiveDate: '2026-02-01', localCapacity: 11 },
    });
    expect(updated.status).toBe(200);
    const saved = (await updated.json()) as Capacity;
    expect(saved).toMatchObject({ id: original.id, revision: original.revision + 1, localCapacity: 11 });
    expect(await session.capacities({ orgId: org.id, asOf: '2026-01-31' })).toContainEqual(
      expect.objectContaining({ id: original.id, localCapacity: 10 }),
    );
    expect(await session.capacities({ orgId: org.id, asOf: '2026-02-01' })).toContainEqual(
      expect.objectContaining({ id: original.id, localCapacity: 11 }),
    );
    const stale = await session.request('PATCH', `/capacities/${original.id}`, {
      ifMatch: original.revision,
      body: { effectiveDate: '2026-03-01', localCapacity: 12 },
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');
    const backdated = await session.request('PATCH', `/capacities/${original.id}`, {
      ifMatch: saved.revision,
      body: { effectiveDate: '2026-01-15', localCapacity: 13 },
    });
    expect(backdated.status).toBe(409);
    expect(await session.capacities({ orgId: org.id, asOf: '2026-02-01' })).toContainEqual(
      expect.objectContaining({ id: original.id, localCapacity: 11, revision: saved.revision }),
    );
  });

  it('另一租户读不到编制、不能借用ID修改，底层RLS同样隐藏', async () => {
    const { db } = testDb();
    const owner = await establishmentSession(db, 'est-owner');
    const stranger = await establishmentSession(db, 'est-stranger');
    const org = await owner.create('隔离部门');
    const scheme = await owner.scheme();
    const capacity = await owner.capacity(org.id, scheme.id);
    expect(await stranger.capacities({ orgId: org.id })).toEqual([]);
    const denied = await stranger.request('PATCH', `/capacities/${capacity.id}`, {
      ifMatch: capacity.revision,
      body: { effectiveDate: '2026-02-01', localCapacity: 100 },
    });
    expect(denied.status).toBe(404);
    const hidden = await withTenant(db, stranger.tenant.id, (tx) =>
      tx.execute(sql`SELECT id FROM establishment_objects WHERE id = ${capacity.id}`),
    );
    expect(resultRows(hidden)).toEqual([]);
    expect(await owner.capacities({ orgId: org.id })).toContainEqual(
      expect.objectContaining({ id: capacity.id, localCapacity: 10, revision: capacity.revision }),
    );
  });

  it('过滤条件在分页前应用，默认有界且超过上限拒绝', async () => {
    const session = await establishmentSession(testDb().db, 'est-pagination');
    const first = await session.create('分页第一部门');
    const second = await session.create('分页目标部门');
    const scheme = await session.scheme();
    await session.capacity(first.id, scheme.id);
    const target = await session.capacity(second.id, scheme.id);
    expect(await session.capacities({ orgId: second.id, pageSize: '1' })).toEqual([target]);
    const invalid = await session.request('GET', '/capacities?pageSize=201');
    expect(invalid.status).toBe(400);
  });
});
