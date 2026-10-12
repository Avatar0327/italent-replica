/** D3 / AC-SC-03、04 / SP-13、14：入口、接管、终止、投影的首批红测。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRun, planSyncRun } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { syncFixture } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { syncTestTransaction } from './AC-SC-sync-support.js';

const binding = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../apps/api/src/modules/succession/ports.js', async (original) => ({
  ...(await original<object>()),
  getSuccessionSync: () => binding.current,
}));

let handle: DbHandle;
let w: SuccessionWorld;
let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
beforeAll(async () => {
  handle = await createTestDb();
  w = await successionWorld(handle.db, 'sc-d3');
  std = await w.standard();
  await w.asTenant(async (tx) => {
    await overrideSetting(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        key: 'succession.system_principal_user_id',
        expectedRevision: 0,
        now: SC_NOW,
        commandId: randomUUID(),
      },
      w.user.id,
    );
    await tx.execute(sql`INSERT INTO permission_profiles (tenant_id,code,name,source)
      VALUES (${w.tenant.id}::uuid,'standard_succession_runner','继任执行身份','standard') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_grants (tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles
      WHERE tenant_id=${w.tenant.id}::uuid AND code='standard_succession_runner' ON CONFLICT DO NOTHING`);
  });
}, 180_000);
afterAll(async () => {
  await handle?.close();
});

async function setup() {
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL WHERE tenant_id=${w.tenant.id}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_batches SET status='terminated' WHERE tenant_id=${w.tenant.id}::uuid`);
  });
  const fixture = syncFixture();
  const run = fixture.runs![0]!;
  const runId = randomUUID();
  const port = createInMemoryTalentReviewSyncPort({
    ...fixture,
    tenantId: w.tenant.id,
    runs: [
      {
        ...run,
        header: {
          ...run.header,
          runId,
          actorUserId: w.user.id,
          ownerUserId: w.user.id,
          principalUserId: w.user.id,
          businessDate: SC_TODAY,
          scopeExplicit: true,
          scopeOrgIds: [std.orgB.id],
        },
        nominations: [
          {
            ...run.nominations[0]!,
            kind: 'org',
            direction: 'successor',
            orgId: std.orgB.id,
            positionId: null,
            successorEmployeeId: std.successor1.id,
            readinessId: null,
            readinessCode: null,
          },
        ],
        orgHealth: [],
      },
    ],
  });
  const input = { tenantId: w.tenant.id, runId, leaseOwner: randomUUID() };
  const deps = {
    db: w.db,
    port,
    clock: () => SC_NOW,
    authorize: () => true,
    transaction: syncTestTransaction(w.db, w.tenant.id, port),
  };
  binding.current = deps;
  const batch = await planSyncRun(deps, input);
  expect(batch?.status).toBe('executing');
  return { input, deps, port, batch: batch! };
}

describe('AC-SC-03/04 D3 同步入口与恢复', () => {
  it('租约到期后新 worker 经 beginConsumption 接管，执行号递增并完成', async () => {
    const h = await setup();
    h.port.advance(121);
    const result = await consumeRun(h.deps, { ...h.input, leaseOwner: randomUUID() });
    expect(result?.status).toBe('completed');
    expect(result?.executionNo).toBe(2);
    expect(result?.result).toBe('succeeded');
  });

  it('同步批次详情、目标与提名路由返回当前可见行和计数', async () => {
    const h = await setup();
    const response = await w.request('GET', `/sync-batches/${h.batch.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: h.batch.id, visibleCounts: { targets: 1, items: 1 } });
    for (const kind of ['items', 'targets']) {
      const rows = await w.request('GET', `/sync-batches/${h.batch.id}/${kind}`);
      expect(rows.status).toBe(200);
      expect(await rows.json()).toMatchObject({ total: 1 });
    }
  });

  it('列表分页包含批次，未知批次详情仍为 404', async () => {
    const h = await setup();
    const response = await w.request('GET', '/sync-batches?pageSize=200');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: h.batch.id })]),
    });
    expect((await w.request('GET', `/sync-batches/${randomUUID()}`)).status).toBe(404);
  });

  it('终态批次 retry 返回 403 RUN_NOT_RETRYABLE，业务记录不变', async () => {
    const h = await setup();
    const completed = await consumeRun(h.deps, h.input);
    expect(completed?.status).toBe('completed');
    const before = await w.asTenant((tx) =>
      tx.execute(sql`SELECT id,revision FROM succession_records
      WHERE tenant_id=${w.tenant.id}::uuid ORDER BY id`),
    );
    const response = await w.request('POST', `/sync-batches/${h.batch.id}/retry`, {
      ifMatch: completed!.revision,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'RUN_NOT_RETRYABLE' } } });
    const after = await w.asTenant((tx) =>
      tx.execute(sql`SELECT id,revision FROM succession_records
      WHERE tenant_id=${w.tenant.id}::uuid ORDER BY id`),
    );
    expect(rowsOf(after)).toEqual(rowsOf(before));
  });

  it('项目重启只清理本地未终态行，终止原因是 superseded', async () => {
    const h = await setup();
    await h.port.supersede(h.input.runId);
    const result = await consumeRun(h.deps, h.input);
    expect(result).toMatchObject({ status: 'terminated', endReason: 'superseded' });
    const targets = await w.asTenant((tx) =>
      tx.execute(sql`SELECT status,retryable FROM succession_sync_targets
      WHERE tenant_id=${w.tenant.id}::uuid AND batch_id=${h.batch.id}::uuid`),
    );
    expect(rowsOf(targets)).toEqual([{ status: 'aborted', retryable: false }]);
  });

  it('页级故障保留屏障并登记首次一分钟退避', async () => {
    const h = await setup();
    const deps = { ...h.deps, authorize: () => false };
    const result = await consumeRun(deps, h.input);
    expect(result).toMatchObject({ status: 'blocked', hasPlan: true, autoRetryCount: 0 });
    expect(result?.nextRetryAt?.toISOString()).toBe(new Date(SC_NOW.getTime() + 60_000).toISOString());
    const mutex = await w.asTenant((tx) =>
      tx.execute(sql`SELECT batch_id FROM succession_sync_mutex
      WHERE tenant_id=${w.tenant.id}::uuid`),
    );
    expect(rowsOf(mutex)).toEqual([{ batch_id: h.batch.id }]);
  });
});

describe('DEC-453① 无计划终止', () => {
  it.each(['waiting', 'blocked'])('%s 无执行号时先分配再终止，不建计划、不写业务数据', async (status) => {
    const h = await setup();
    const freshId = randomUUID();
    const fixture = syncFixture();
    const run = fixture.runs![0]!;
    const port = createInMemoryTalentReviewSyncPort({
      ...fixture,
      tenantId: w.tenant.id,
      runs: [{ ...run, header: { ...run.header, runId: freshId } }],
    });
    // HTTP 命令拥有 SQL 事务；替身消费操作必须由同一外层内存事务发布。
    binding.current = { ...h.deps, port };
    const id = randomUUID();
    await w.asTenant((tx) =>
      tx.execute(sql`INSERT INTO succession_sync_batches
      (id,tenant_id,source_run_id,project_id,trigger,actor_user_id,owner_user_id,
       source_principal_user_id,business_date,status)
      VALUES (${id}::uuid,${w.tenant.id}::uuid,${freshId}::uuid,${run.header.projectId}::uuid,
      'sync_requested',${w.user.id}::uuid,${w.user.id}::uuid,${w.user.id}::uuid,${SC_TODAY},${status})`),
    );
    const before = await w.asTenant((tx) => tx.execute(sql`SELECT id,revision FROM succession_records ORDER BY id`));
    const begin = vi.spyOn(port, 'beginConsumption');
    const abort = vi.spyOn(port, 'abortConsumption');
    const result = await port.transaction(async (memory) => {
      const nativePort = new Proxy(port, {
        get(target, name) {
          const fn: unknown = Reflect.get(target, name);
          return typeof fn === 'function' ? (_tx: unknown, input: unknown) => fn.call(target, memory, input) : fn;
        },
      });
      binding.current = { ...h.deps, port: nativePort };
      return w.request('POST', `/sync-batches/${id}/abort`, { ifMatch: 1, body: {} });
    });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(begin).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        executionNo: 1,
        code: 'ABORTED_BY_ADMIN',
        recovery: 'terminate',
      }),
    );
    const local = await w.asTenant((tx) =>
      tx.execute(sql`SELECT status,has_plan,execution_no,end_reason
      FROM succession_sync_batches WHERE id=${id}::uuid`),
    );
    expect(rowsOf(local)).toEqual([{ status: 'terminated', has_plan: false, execution_no: 1, end_reason: 'aborted' }]);
    const after = await w.asTenant((tx) => tx.execute(sql`SELECT id,revision FROM succession_records ORDER BY id`));
    expect(rowsOf(after)).toEqual(rowsOf(before));
    const plans = await w.asTenant((tx) =>
      tx.execute(sql`SELECT id FROM succession_sync_targets WHERE batch_id=${id}::uuid`),
    );
    expect(rowsOf(plans)).toEqual([]);
  });
});
