import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/establishment/store.js';
import { establishmentSession, type Capacity, type CopyJob, type EstablishmentSession } from './AC-EST-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

/** DEC-295①：北森原文“{组织}已设有{M}月编制，编制方案为{方案}，不可新建，请检查”（Q-M0-116，18 §14）。 */
const overlapMessage = (org: string, month: number, scheme: string) =>
  `${org}已设有${month}月编制，编制方案为${scheme}，不可新建，请检查`;

async function post(session: EstablishmentSession, orgId: string, schemeId: string, periodStart: string) {
  return session.request('POST', '/capacities', {
    ifMatch: 0,
    body: { orgId, schemeId, periodStart, localCapacity: 10, strictControl: false },
  });
}

async function expectOverlap(response: Response, message: string, reason: string) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT', message, details: { reason } } });
}

async function setup(label: string, options: { establishedOn?: string; schemeStart?: string } = {}) {
  const session = await establishmentSession(testDb().db, `${label}-${uniqueSuffix()}`);
  const orgName = `重叠校验部门${uniqueSuffix(12)}`;
  const org = await session.create(orgName, { establishedOn: options.establishedOn ?? '2026-01-01' });
  const schemeStart = options.schemeStart ?? '2026-01-01';
  const annual = await session.scheme({ name: `年度方案${uniqueSuffix(12)}`, startDate: schemeStart });
  const monthly = await session.scheme({
    name: `月度方案${uniqueSuffix(12)}`,
    periodType: 'monthly',
    startDate: schemeStart,
  });
  return { session, org, orgName, annual, monthly };
}

describe('F-484 同一组织重叠期间多方案编制写入校验（DEC-279① / DEC-295①）', () => {
  it('入口 POST /capacities：已有年度编制时，另一方案的月度编制落在其内被拒，提示照北森原文', async () => {
    const w = await setup('f484-cross');
    await w.session.capacity(w.org.id, w.annual.id);
    const denied = await post(w.session, w.org.id, w.monthly.id, '2026-10-01');
    await expectOverlap(denied, overlapMessage(w.orgName, 10, w.annual.name), 'CAPACITY_PERIOD_OVERLAP');
    expect(await w.session.capacities({ orgId: w.org.id })).toHaveLength(1);
  });

  it('入口 POST /capacities：先有月度编制、后建覆盖它的年度编制同样被拒，{M} 取重叠区间的首月', async () => {
    const w = await setup('f484-reverse');
    await w.session.capacity(w.org.id, w.monthly.id, { periodStart: '2026-10-01' });
    // 月度编制自动补齐到年底：10～12 月已有，年度 2026 与之从 10 月起重叠
    const denied = await post(w.session, w.org.id, w.annual.id, '2026-01-01');
    await expectOverlap(denied, overlapMessage(w.orgName, 10, w.monthly.name), 'CAPACITY_PERIOD_OVERLAP');
  });

  it('入口 POST /capacities：同方案同周期重复仍拒绝，提示同为 DEC-295 原文（原因码保持 CAPACITY_EXISTS）', async () => {
    const w = await setup('f484-same');
    await w.session.capacity(w.org.id, w.annual.id);
    const denied = await post(w.session, w.org.id, w.annual.id, '2026-01-01');
    await expectOverlap(denied, overlapMessage(w.orgName, 1, w.annual.name), 'CAPACITY_EXISTS');
  });

  it('首尾相接不算重叠：去年年度编制与今年月度编制并存，月度补齐到年底', async () => {
    const w = await setup('f484-adjacent', { establishedOn: '2025-01-01', schemeStart: '2025-01-01' });
    await w.session.capacity(w.org.id, w.annual.id, { periodStart: '2025-01-01' });
    const created = await post(w.session, w.org.id, w.monthly.id, '2026-01-01');
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await w.session.capacities({ orgId: w.org.id, asOf: '2026-12-31' })).toHaveLength(13);
  });

  it('不同组织放行：同一周期、不同方案各建在不同组织上不互相影响', async () => {
    const w = await setup('f484-orgs');
    const other = await w.session.create(`另一部门${uniqueSuffix(12)}`, { establishedOn: '2026-01-01' });
    await w.session.capacity(w.org.id, w.annual.id);
    const created = await post(w.session, other.id, w.monthly.id, '2026-10-01');
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('跨租户互不影响：别的租户同一周期已有编制，本租户新建不受阻', async () => {
    const a = await setup('f484-tenant-a');
    const b = await setup('f484-tenant-b');
    await a.session.capacity(a.org.id, a.annual.id);
    const created = await post(b.session, b.org.id, b.monthly.id, '2026-10-01');
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('已停用方案的历史编制仍参与判定：同组织重叠月份不可再以别的方案新建', async () => {
    const w = await setup('f484-disabled', { establishedOn: '2025-01-01', schemeStart: '2025-01-01' });
    await w.session.capacity(w.org.id, w.annual.id, { periodStart: '2025-01-01' });
    const disabled = await w.session.request('PATCH', `/schemes/${w.annual.id}`, {
      ifMatch: w.annual.revision,
      body: { effectiveDate: '2026-10-01', enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const denied = await post(w.session, w.org.id, w.monthly.id, '2025-06-01');
    await expectOverlap(denied, overlapMessage(w.orgName, 6, w.annual.name), 'CAPACITY_PERIOD_OVERLAP');
  });

  it('入口 月度补齐：补齐的月份被别的方案占用时跳过该月，不拦住用户指定的首期，也不产生重叠', async () => {
    const w = await setup('f484-autofill');
    const quarterly = await w.session.scheme({ name: `季度方案${uniqueSuffix(12)}`, periodType: 'quarterly' });
    await w.session.capacity(w.org.id, quarterly.id, { periodStart: '2026-10-01' });
    const created = await post(w.session, w.org.id, w.monthly.id, '2026-01-01');
    expect(created.status, await created.clone().text()).toBe(201);
    const rows = await w.session.capacities({ orgId: w.org.id, asOf: '2026-12-31' });
    const monthly = rows.filter((row) => row.schemeId === w.monthly.id).map((row) => row.periodStart);
    expect(monthly).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
    expect(rows.filter((row) => row.schemeId === quarterly.id)).toHaveLength(1);
  });

  it('入口 复制下期：目标周期与别的方案编制重叠时任务 failed、原因为 DEC-295 原文，整批不落地', async () => {
    const w = await setup('f484-copy');
    const source = await w.session.capacity(w.org.id, w.annual.id);
    await w.session.capacity(w.org.id, w.monthly.id, { periodStart: '2027-03-01' });
    const before = await w.session.capacities({ orgId: w.org.id, asOf: '2027-12-31' });
    const enqueued = await w.session.request('POST', '/copy-jobs', { ifMatch: 0, body: { capacityIds: [source.id] } });
    expect(enqueued.status).toBe(202);
    const pending = (await enqueued.json()) as CopyJob;
    const executed = await w.session.request('POST', `/copy-jobs/${pending.id}/execute`, {
      ifMatch: pending.revision,
      body: {},
    });
    expect(executed.status).toBe(200);
    const job = (await executed.json()) as CopyJob;
    expect(job.status).toBe('failed');
    expect(job.failureReason).toContain(overlapMessage(w.orgName, 3, w.monthly.name));
    expect(await w.session.capacities({ orgId: w.org.id, asOf: '2027-12-31' })).toEqual(before);
  });

  it('入口 PATCH /capacities/:id：编制对象的组织、方案、周期不可修改，改期不能绕开重叠校验', async () => {
    const w = await setup('f484-patch');
    const annual = await w.session.capacity(w.org.id, w.annual.id);
    const moved = await w.session.request('PATCH', `/capacities/${annual.id}`, {
      ifMatch: annual.revision,
      body: { effectiveDate: '2026-10-01', periodStart: '2027-01-01' },
    });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('不阻塞合法动作：重叠被拒后原编制仍可读、可改数', async () => {
    const w = await setup('f484-after-deny');
    const annual = await w.session.capacity(w.org.id, w.annual.id);
    await post(w.session, w.org.id, w.monthly.id, '2026-10-01');
    const updated = await w.session.request('PATCH', `/capacities/${annual.id}`, {
      ifMatch: annual.revision,
      body: { effectiveDate: '2026-10-01', localCapacity: 12 },
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect((await updated.json()) as Capacity).toMatchObject({ localCapacity: 12 });
  });
});

async function blocked(db: Db, count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.n === count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未观察到 ${count} 个 PostgreSQL 锁等待者`);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('F-484 并发重叠写只成功一个（PG）', () => {
  it('两个请求同时为同一组织写重叠期间：持同一把编制租户锁串行，一个 201、一个 409，库中无重叠行', async () => {
    const w = await setup('f484-race');
    const { db } = testDb();
    const requests = await withTenant(db, w.session.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT tenant_id FROM establishment_settings
        WHERE tenant_id=${w.session.tenant.id} FOR UPDATE`);
      const first = post(w.session, w.org.id, w.annual.id, '2026-01-01');
      await blocked(db, 1);
      const second = post(w.session, w.org.id, w.monthly.id, '2026-10-01');
      await blocked(db, 2);
      return [first, second];
    });
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await withTenant(db, w.session.tenant.id, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM establishment_objects a
          JOIN establishment_objects b ON a.tenant_id=b.tenant_id AND a.org_id=b.org_id AND a.id<b.id
            AND a.period_start<=b.period_end AND b.period_start<=a.period_end
          WHERE a.tenant_id=${w.session.tenant.id}`),
      ),
    );
    expect(rows[0]!.n).toBe(0);
  });
});
