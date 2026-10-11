/** DEC-429：生产者替身只在测试登记，真实业务集合由 A3/C1/B4 提供。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
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
});
