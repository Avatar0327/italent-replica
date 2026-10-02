import { randomUUID } from 'node:crypto';
import { eq, jobLevelTypeObjects, jobLevelTypeVersions, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const asOf = '2026-10-01';
const clock = () => new Date('2026-10-01T02:00:00Z');
const base = '/api/tenant/job/level-types';
type Item = { id: string; code: string; name: string; revision: number };

async function session(label: string) {
  const member = await seedTenantWithMember(testDb().db, label);
  const api = tenantApi(testDb().db, { clock });
  const auth = { tenant: member.tenant.id, user: member.user.id };
  async function create(name: string, code: string = randomUUID()) {
    const response = await api.request('POST', base, {
      ...auth,
      ifMatch: 0,
      body: { name, code, startDate: asOf },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Item;
  }
  return { ...member, api, auth, create };
}

describe('AC-JOB 平台约定与隔离', () => {
  it('写命令必须携带 revision/幂等键，同键重放不重复追加版本', async () => {
    const s = await session('job-ledger');
    const body = { code: 'TYPE-LEDGER', name: '专业类', startDate: asOf };
    const missingRevision = await s.api.request('POST', base, { ...s.auth, body });
    expect(missingRevision.status).toBe(400);
    const missingKey = await s.api.request('POST', base, {
      ...s.auth,
      body,
      ifMatch: 0,
      idempotencyKey: null,
    });
    expect(missingKey.status).toBe(400);
    const options = { ...s.auth, body, ifMatch: 0, idempotencyKey: randomUUID() };
    const first = await s.api.request('POST', base, options);
    expect(first.status).toBe(201);
    const item = (await first.json()) as Item;
    const replay = await s.api.request('POST', base, options);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(item);
    const conflict = await s.api.request('POST', base, { ...options, body: { ...body, name: '管理类' } });
    expect(conflict.status).toBe(409);
    const versions = await withTenant(testDb().db, s.tenant.id, (tx) =>
      tx.select().from(jobLevelTypeVersions).where(eq(jobLevelTypeVersions.objectId, item.id)),
    );
    expect(versions).toHaveLength(1);
  });

  it('DEC-072 拒绝在未来版本之前插入变更，历史查询保留旧编码', async () => {
    const s = await session('job-history');
    const item = await s.create('专业类', 'TYPE-OLD');
    const changed = await s.api.request('PATCH', `${base}/${item.id}`, {
      ...s.auth,
      ifMatch: item.revision,
      body: { code: 'TYPE-NEW', name: '新专业类', effectiveDate: '2027-01-01' },
    });
    expect(changed.status).toBe(200);
    const latest = (await changed.json()) as Item;
    const stale = await s.api.request('PATCH', `${base}/${item.id}`, {
      ...s.auth,
      ifMatch: item.revision,
      body: { name: '过期版本', effectiveDate: '2027-02-01' },
    });
    expect(stale.status).toBe(409);
    const earlier = await s.api.request('PATCH', `${base}/${item.id}`, {
      ...s.auth,
      ifMatch: latest.revision,
      body: { name: '插入过去', effectiveDate: '2026-11-01' },
    });
    expect(earlier.status).toBe(409);
    expect(await earlier.json()).toMatchObject({ error: { code: 'JOB_FUTURE_VERSION_EXISTS' } });
    const before = await s.api.request('GET', `${base}/${item.id}?asOf=2026-12-01`, s.auth);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ id: item.id, code: 'TYPE-OLD', name: '专业类' });
    const after = await s.api.request('GET', `${base}/${item.id}?asOf=2027-01-01`, s.auth);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ id: item.id, code: 'TYPE-NEW', name: '新专业类' });
  });

  it('名称筛选在分页之前执行，列表分页并拒绝超过 200', async () => {
    const s = await session('job-page');
    await s.create('A 不匹配', 'A');
    await s.create('B 不匹配', 'B');
    const target = await s.create('目标职级类别', 'Z');
    const query = new URLSearchParams({ asOf, page: '1', pageSize: '1', name: target.name });
    const filtered = await s.api.request('GET', `${base}?${query}`, s.auth);
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { items: Item[] }).items).toEqual([expect.objectContaining({ id: target.id })]);
    const firstPage = await s.api.request('GET', `${base}?pageSize=2&asOf=${asOf}`, s.auth);
    expect(((await firstPage.json()) as { items: Item[] }).items).toHaveLength(2);
    const secondPage = await s.api.request('GET', `${base}?page=2&pageSize=2&asOf=${asOf}`, s.auth);
    expect(((await secondPage.json()) as { items: Item[] }).items).toHaveLength(1);
    const tooLarge = await s.api.request('GET', `${base}?pageSize=201`, s.auth);
    expect(tooLarge.status).toBe(400);
  });

  it('同名同码可分属两个租户；API 与真实主数据表均隔离', async () => {
    const a = await session('job-tenant-a');
    const b = await session('job-tenant-b');
    const first = await a.create('专业类', 'TYPE-SHARED');
    const second = await b.create('专业类', 'TYPE-SHARED');
    expect(first.id).not.toBe(second.id);
    const foreign = await a.api.request('GET', `${base}/${second.id}?asOf=${asOf}`, a.auth);
    expect(foreign.status).toBe(404);
    const invisible = await withTenant(testDb().db, a.tenant.id, (tx) =>
      tx.select().from(jobLevelTypeObjects).where(eq(jobLevelTypeObjects.id, second.id)),
    );
    expect(invisible).toEqual([]);
    await expect(
      withTenant(testDb().db, a.tenant.id, (tx) => tx.insert(jobLevelTypeObjects).values({ tenantId: b.tenant.id })),
    ).rejects.toThrow();
  });
});
