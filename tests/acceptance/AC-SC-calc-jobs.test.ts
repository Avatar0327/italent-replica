/** DEC-429：生产者替身只在测试登记，真实业务集合由 A3/C1/B4 提供。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, withPlatform, type Db, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';
import { seedOperator } from './support/platform-api.js';
import { enqueueCalcRun } from '../../apps/api/src/modules/succession/calc-worker.js';
import {
  SUCCESSION_PRODUCERS,
  dispatchCalcJobs,
  type CalcProducer,
} from '../../apps/api/src/modules/succession/calc-jobs.js';
import { SUCCESSION_CALC_KINDS, type CalcHandler } from '../../apps/api/src/modules/succession/calc-contract.js';
import { rowsOf } from './support/f048.js';
vi.mock('../../apps/api/src/modules/succession/calc-jobs.js', async (original) => ({
  ...(await original<object>()),
  SUCCESSION_PRODUCERS: [],
}));
vi.mock('../../apps/api/src/modules/succession/calc-contract.js', async (original) => ({
  ...(await original<object>()),
  SUCCESSION_CALC_KINDS: [],
}));
const testDb = useTestDb();
const db = () => testDb().db;
const now = new Date('2026-10-11T08:00:00Z');
const PATH = '/api/platform/succession/jobs/run';
let tenants: Awaited<ReturnType<typeof seedTenantWithMember>>[];
let operator: Awaited<ReturnType<typeof seedOperator>>;
let objectIds: string[] = [];
const producer: CalcProducer = {
  kind: 'org_stats',
  async runTenant(t: Tx, tenant, time) {
    await enqueueCalcRun(
      t,
      {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        now: time,
        kind: 'org_stats',
        trigger: 'schedule',
        intervalHours: 4,
        requestedBy: null,
        businessDate: tenantLocalDate(time, tenant.timezone),
        commandId: randomUUID(),
        objects: objectIds.map((objectId) => ({ objectType: 'org', objectId })),
      },
      time,
    );
  },
};
const list = (tenantId: string) =>
  withTenant(db(), tenantId, async (t) =>
    rowsOf<{ id: string; status: string }>(
      await t.execute(sql`SELECT id,status FROM succession_calc_runs ORDER BY id`),
    ),
  );
beforeAll(async () => {
  tenants = await Promise.all(['jobs-a', 'jobs-b', 'jobs-c'].map((label) => seedTenantWithMember(db(), label)));
  tenants.sort((a, b) => a.tenant.id.localeCompare(b.tenant.id));
  operator = await seedOperator(db());
  (SUCCESSION_PRODUCERS as CalcProducer[]).push(producer);
  (SUCCESSION_CALC_KINDS as CalcHandler[]).push({
    kind: 'org_stats',
    objectType: 'org',
    authorizePage: async ({ run }) => tenants.find((s) => s.tenant.id === run.tenantId)!.user.id,
    execute: async () => 'written',
  });
});

describe('AC-SC-calc-jobs 按租户调度', () => {
  it('平台入口限制指定租户，重放与同槽新命令均不重复建 run；跨槽重放也不新建', async () => {
    let time = now;
    const api = tenantApi(db(), { clock: () => time });
    const opts = {
      user: operator.id,
      body: { kind: 'org_stats', tenantId: tenants[0]!.tenant.id },
      idempotencyKey: randomUUID(),
    };
    const res = await api.request('POST', PATH, opts);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await list(tenants[0]!.tenant.id)).toMatchObject([{ status: 'succeeded' }]);
    expect(await list(tenants[1]!.tenant.id)).toEqual([]);
    expect((await api.request('POST', PATH, opts)).status).toBe(200);
    expect((await api.request('POST', PATH, { ...opts, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await list(tenants[0]!.tenant.id)).toHaveLength(1);
    time = new Date('2026-10-12T08:00:00Z');
    expect((await api.request('POST', PATH, opts)).status).toBe(200);
    expect(await list(tenants[0]!.tenant.id)).toHaveLength(1);
  });
  it('租户游标续页；每页只推进选中租户，末页无游标', async () => {
    const first = await dispatchCalcJobs(
      { db: db(), clock: () => now },
      {
        kind: 'org_stats',
        userId: operator.id,
        commandId: randomUUID(),
        pageSize: 1,
      },
      SUCCESSION_PRODUCERS,
    );
    expect(first.nextCursor).toBe(tenants[0]!.tenant.id);
    expect(await list(tenants[1]!.tenant.id)).toEqual([]);
    const second = await dispatchCalcJobs(
      { db: db(), clock: () => now },
      {
        kind: 'org_stats',
        userId: operator.id,
        commandId: randomUUID(),
        cursor: first.nextCursor!,
        pageSize: 1,
      },
      SUCCESSION_PRODUCERS,
    );
    expect(second.nextCursor).toBe(tenants[1]!.tenant.id);
    expect(await list(tenants[1]!.tenant.id)).toMatchObject([{ status: 'succeeded' }]);
    const last = await dispatchCalcJobs(
      { db: db(), clock: () => now },
      {
        kind: 'org_stats',
        userId: operator.id,
        commandId: randomUUID(),
        cursor: second.nextCursor!,
        pageSize: 1,
      },
      SUCCESSION_PRODUCERS,
    );
    expect(last.nextCursor).toBeNull();
    expect(await list(tenants[2]!.tenant.id)).toMatchObject([{ status: 'succeeded' }]);
  });
  it('平台命令恢复推进 running；同一当期重放不重复执行冻结对象', async () => {
    objectIds = Array.from({ length: 201 }, () => randomUUID());
    const input = {
      kind: 'org_stats' as const,
      tenantId: tenants[2]!.tenant.id,
      userId: operator.id,
      commandId: randomUUID(),
    };
    const deps = { db: db(), clock: () => new Date('2026-10-12T08:00:00Z') };
    const first = await dispatchCalcJobs(deps, input, SUCCESSION_PRODUCERS);
    const id = first.items[0]!.runIds![0]!;
    expect((await list(input.tenantId)).find((run) => run.id === id)?.status).toBe('running');
    const resumed = await dispatchCalcJobs(deps, input, SUCCESSION_PRODUCERS);
    expect(resumed).toEqual(first);
    expect((await list(input.tenantId)).find((run) => run.id === id)?.status).toBe('succeeded');
    expect(
      await withTenant(db(), input.tenantId, async (t) =>
        rowsOf(
          await t.execute(sql`
      SELECT count(*)::int n FROM succession_calc_run_objects WHERE run_id=${id}::uuid AND outcome='written'`),
        ),
      ),
    ).toEqual([{ n: 201 }]);
    objectIds = [];
  });
  it('无平台身份、非法输入、缺幂等键、未登记 kind 明确拒绝', async () => {
    const api = tenantApi(db());
    const body = { kind: 'org_stats', tenantId: tenants[0]!.tenant.id };
    expect((await api.request('POST', PATH, { user: tenants[0]!.user.id, body })).status).toBe(403);
    expect((await api.request('POST', PATH, { user: operator.id, body: { ...body, cursor: 'bad' } })).status).toBe(400);
    expect((await api.request('POST', PATH, { user: operator.id, body, idempotencyKey: null })).status).toBe(400);
    const missing = await api.request('POST', PATH, { user: operator.id, body: { ...body, kind: 'exit_sweep' } });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: { details: { reason: 'KIND_UNAVAILABLE' } } });
  });
  it('P2-1：平台计划提交回包丢失后回查，且同键并发跨槽只生产一个周期', async () => {
    const tenantId = tenants[0]!.tenant.id;
    const actual = db();
    let lost = false;
    const transaction: Db['transaction'] = async (callback, config) => {
      const value = await actual.transaction(callback, config);
      if (!lost && value && typeof value === 'object' && 'productionAt' in value) {
        lost = true;
        throw new Error('合成平台计划提交回包丢失');
      }
      return value;
    };
    const wrapped = new Proxy(actual, {
      get: (target, key, receiver) => (key === 'transaction' ? transaction : Reflect.get(target, key, receiver)),
    });
    const input = { kind: 'org_stats' as const, tenantId, userId: operator.id, commandId: randomUUID() };
    const before = await list(tenantId);
    const results = await Promise.all(
      ['2026-10-20', '2026-10-21'].map((date) =>
        dispatchCalcJobs({ db: wrapped, clock: () => new Date(`${date}T08:00:00Z`) }, input, SUCCESSION_PRODUCERS),
      ),
    );
    expect(lost).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.items[0]).toHaveProperty('runIds');
    expect(await list(tenantId)).toHaveLength(before.length + 1);
    const conflict = await tenantApi(db()).request('POST', PATH, {
      user: operator.id,
      body: { kind: 'org_stats', tenantId: tenants[1]!.tenant.id },
      idempotencyKey: input.commandId,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
  it('P2-1：租户停用 / 新增后的跨槽 HTTP 重放保持第一页、游标与 run 集合', async () => {
    for (let i = 0; i < 18; i++) tenants.push(await seedTenantWithMember(db(), `page-${i}`));
    tenants.sort((a, b) => a.tenant.id.localeCompare(b.tenant.id));
    let time = new Date('2026-11-01T08:00:00Z');
    const api = tenantApi(db(), { clock: () => time });
    const opts = { user: operator.id, body: { kind: 'org_stats' }, idempotencyKey: randomUUID() };
    const initial = await api.request('POST', PATH, opts);
    expect(initial.status).toBe(200);
    const first = await initial.json();
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe(tenants[19]!.tenant.id);
    const before = await Promise.all(tenants.map((tenant) => list(tenant.tenant.id)));
    await withPlatform(db(), (t) =>
      t.execute(sql`
      UPDATE tenants SET status='suspended' WHERE id=${tenants[0]!.tenant.id}::uuid`),
    );
    tenants.push(await seedTenantWithMember(db(), 'page-new'));
    time = new Date('2026-11-02T08:00:00Z');
    const replay = await api.request('POST', PATH, opts);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    expect(await Promise.all(tenants.slice(0, 21).map((tenant) => list(tenant.tenant.id)))).toEqual(before);
    expect(await list(tenants[21]!.tenant.id)).toEqual([]);
  });
  it('P2-1：某租户生产失败后跨槽恢复仍使用首次生产时点', async () => {
    const tenantId = tenants[1]!.tenant.id;
    let time = new Date('2026-11-03T08:00:00Z'),
      fail = true;
    const times: string[] = [];
    const flaky: CalcProducer = {
      ...producer,
      async runTenant(tx, tenant, at) {
        times.push(at.toISOString());
        if (fail) throw new Error('合成生产失败');
        await producer.runTenant(tx, tenant, at);
      },
    };
    const deps = { db: db(), clock: () => time };
    const input = { kind: 'org_stats' as const, tenantId, userId: operator.id, commandId: randomUUID() };
    expect((await dispatchCalcJobs(deps, input, [flaky])).items[0]).toHaveProperty('error');
    fail = false;
    time = new Date('2026-11-04T08:00:00Z');
    expect((await dispatchCalcJobs(deps, input, [flaky])).items[0]).toHaveProperty('runIds');
    expect(times).toEqual(['2026-11-03T08:00:00.000Z', '2026-11-03T08:00:00.000Z']);
  });
});
