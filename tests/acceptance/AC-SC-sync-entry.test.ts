/** D3 / AC-SC-03、04 / SP-13、14：入口、接管、终止、投影的首批红测。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRun, planSyncRun, mutex } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { syncFixture } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { abortSync } from '../../apps/api/src/modules/succession/sync-control.js';
import { SUCCESSION_AUDIT } from '../../apps/api/src/modules/succession/audit-scope.js';
import * as audit from '../../apps/api/src/audit/record.js';
import { recoverSyncBatches } from '../../apps/api/src/modules/succession/sync-recovery.js';
import { tenantApi } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
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
      VALUES (${w.tenant.id}::uuid,'standard_succession_admin','继任管理员','standard') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_grants (tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles
      WHERE tenant_id=${w.tenant.id}::uuid AND code='standard_succession_admin' ON CONFLICT DO NOTHING`);
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

async function setup(plan = true) {
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
  const batch = plan ? await planSyncRun(deps, input) : undefined;
  if (plan) expect(batch?.status).toBe('executing');
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
    const event = (await batchAudit(id, 'terminated'))[0]!;
    expect(event.actor).toBe(w.user.id);
    expect(event.before).toMatchObject({ status, hasPlan: false, executionNo: null });
    expect(event.after).toMatchObject({ status: 'terminated', hasPlan: false, executionNo: 1 });
    expect(Object.keys(event.before).sort()).toEqual(Object.keys(event.after).sort());
    const after = await w.asTenant((tx) => tx.execute(sql`SELECT id,revision FROM succession_records ORDER BY id`));
    expect(rowsOf(after)).toEqual(rowsOf(before));
    const plans = await w.asTenant((tx) =>
      tx.execute(sql`SELECT id FROM succession_sync_targets WHERE batch_id=${id}::uuid`),
    );
    expect(rowsOf(plans)).toEqual([]);
    const held = await w.asTenant((tx) =>
      tx.execute(sql`SELECT batch_id FROM succession_sync_mutex
      WHERE tenant_id=${w.tenant.id}::uuid`),
    );
    expect(rowsOf(held)).toEqual([{ batch_id: h.batch.id }]);
    const page = await port.transaction((tx) =>
      port.getOutcomes(tx, {
        tenantId: w.tenant.id,
        runId: freshId,
        consumer: 'succession',
      }),
    );
    expect(page.items.every((row) => row.status === 'aborted')).toBe(true);
  });
});

describe('D3 入口命令与自动恢复', () => {
  it('POST /sync 首次执行和同键重放：只通知一次，不重复业务写入', async () => {
    const h = await setup(false),
      command = randomUUID();
    const call = () =>
      w.request('POST', '/sync', { body: { runId: h.input.runId.toUpperCase() }, idempotencyKey: command });
    const first = await call();
    expect(first.status, await first.clone().text()).toBe(202);
    const body = await first.json();
    expect(body).toMatchObject({ status: 'completed', result: 'succeeded' });
    const replay = await call();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(body);
    const notices = await w.asTenant((tx) =>
      tx.execute(sql`SELECT id FROM succession_notifications
      WHERE batch_id=${(body as { id: string }).id}::uuid AND kind='sync_done'`),
    );
    expect(rowsOf(notices)).toHaveLength(1);
  });
  it('调用人目标授权失败返回 403，不建批次或计划', async () => {
    const h = await setup(false);
    binding.current = { ...h.deps, authorize: () => false };
    const result = await w.request('POST', '/sync', { body: { runId: h.input.runId } });
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: { details: { reason: 'BATCH_SCOPE_EXCEEDS_REQUESTER' } } });
    const rows = await w.asTenant((tx) =>
      tx.execute(sql`SELECT id FROM succession_sync_batches
      WHERE source_run_id=${h.input.runId}::uuid`),
    );
    expect(rowsOf(rows)).toEqual([]);
  });
  it('退避 1/5/30 分钟、最多三次；修复后手动 retry 可恢复并重置次数', async () => {
    const h = await setup();
    let now = SC_NOW;
    const broken = { ...h.deps, authorize: () => false, clock: () => now };
    const state = await consumeRun(broken, h.input);
    expect(state?.nextRetryAt).toEqual(new Date(SC_NOW.getTime() + 60_000));
    // 首次退避已到但租约未到期时不得消耗次数。
    now = new Date(SC_NOW.getTime() + 60_000);
    h.port.advance(60);
    await recoverSyncBatches(broken, w.tenant.id);
    const load = () =>
      w.asTenant(
        async (tx) =>
          rowsOf<{ auto_retry_count: number; next_retry_at: Date | null; status: string }>(
            await tx.execute(
              sql`SELECT auto_retry_count,next_retry_at,status
              FROM succession_sync_batches WHERE id=${h.batch.id}::uuid`,
            ),
          )[0]!,
      );
    expect((await load()).auto_retry_count).toBe(0);
    now = new Date(SC_NOW.getTime() + 121_000);
    h.port.advance(61);
    for (const [attempt, delay] of [
      [1, 5],
      [2, 30],
      [3, 0],
    ]) {
      await recoverSyncBatches(broken, w.tenant.id);
      const row = await load();
      expect(row.auto_retry_count).toBe(attempt);
      expect(row.next_retry_at ? new Date(row.next_retry_at) : null).toEqual(
        delay ? new Date(now.getTime() + delay! * 60_000) : null,
      );
      now = new Date(now.getTime() + (delay || 30) * 60_000);
      h.port.advance((delay || 30) * 60);
    }
    await recoverSyncBatches(h.deps, w.tenant.id);
    expect((await load()).status).toBe('blocked');
    const detail = await w.request('GET', `/sync-batches/${h.batch.id}`);
    const current = (await detail.json()) as { revision: number };
    binding.current = h.deps;
    const retry = await w.request('POST', `/sync-batches/${h.batch.id}/retry`, { ifMatch: current.revision, body: {} });
    expect(retry.status, await retry.clone().text()).toBe(202);
    expect(await retry.json()).toMatchObject({ status: 'completed' });
    expect((await load()).auto_retry_count).toBe(0);
  });
  it('按当前范围重算计数；字段隐藏时明细键不返回', async () => {
    const h = await setup();
    const authorize = () => true;
    registerScopeProvider(authorize, {
      authorize: async () => true,
      scope: async () => EMPTY_SCOPE,
      fields: async () => new Set(['id', 'revision', 'status', 'visibleCounts']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => SC_NOW });
    const options = { tenant: w.tenant.id, user: w.user.id };
    const detail = await api.request('GET', `/api/tenant/succession/sync-batches/${h.batch.id}`, options);
    expect(detail.status).toBe(200); // 原触发人仍可看批次头，但不能获得目标行。
    expect(await detail.json()).toMatchObject({ visibleCounts: { items: 0, targets: 0 } });
    const rows = await api.request('GET', `/api/tenant/succession/sync-batches/${h.batch.id}/items`, options);
    expect(await rows.json()).toEqual({ items: [] });
  });
});

describe('AC-SC-03/04 D3 终止、重放与 SELF 边界', () => {
  it('终止审计失败时本地状态、源回执与互斥全部回滚', async () => {
    const h = await setup();
    const fail = vi.spyOn(audit, 'recordAudit').mockRejectedValueOnce(new Error('测试审计故障'));
    try {
      await expect(
        h.deps.transaction(async (tx) => {
          await mutex(tx, w.tenant.id);
          return abortSync(tx, h.deps, h.batch, randomUUID(), h.batch.revision);
        }),
      ).rejects.toThrow('测试审计故障');
    } finally {
      fail.mockRestore();
    }
    const state = await w.asTenant((tx) =>
      tx.execute(sql`SELECT status,revision FROM succession_sync_batches
      WHERE id=${h.batch.id}::uuid`),
    );
    expect(rowsOf(state)).toEqual([{ status: 'executing', revision: h.batch.revision }]);
    const outcomes = await h.port.transaction((tx) =>
      h.port.getOutcomes(tx, {
        tenantId: w.tenant.id,
        runId: h.input.runId,
        consumer: 'succession',
      }),
    );
    expect(outcomes.items.some((row) => row.status === 'aborted')).toBe(false);
  });
  it('自动重试耗尽后项目重启，恢复扫描仍清理屏障而不调用 abort', async () => {
    const h = await setup();
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_sync_batches
      SET status='blocked',auto_retry_count=3,next_retry_at=NULL WHERE id=${h.batch.id}::uuid`),
    );
    const abort = vi.spyOn(h.port, 'abortConsumption');
    await h.port.supersede(h.input.runId);
    await recoverSyncBatches(h.deps, w.tenant.id);
    const result = await w.request('GET', `/sync-batches/${h.batch.id}`);
    expect(await result.json()).toMatchObject({ status: 'terminated', endReason: 'superseded' });
    expect(abort).not.toHaveBeenCalled();
  });
  it('错误 revision 与撤按钮后的同键重放均拒绝且批次不变', async () => {
    const h = await setup(),
      command = randomUUID();
    const denied = await w.request('POST', `/sync-batches/${h.batch.id}/retry`, { ifMatch: 0, body: {} });
    expect(denied.status).toBe(409);
    await consumeRun(h.deps, h.input);
    // 同 run 的 POST /sync 必须是新命令 403；拒绝不产生台账成功项。
    const terminal = await w.request('POST', '/sync', { body: { runId: h.input.runId }, idempotencyKey: command });
    expect(terminal.status).toBe(403);
    const fresh = await setup(false);
    const first = await w.request('POST', '/sync', { body: { runId: fresh.input.runId }, idempotencyKey: command });
    expect(first.status).toBe(202);
    const api = tenantApi(w.db, { authorize: (req) => req.action !== 'object.button', clock: () => SC_NOW });
    const replay = await api.request('POST', '/api/tenant/succession/sync', {
      tenant: w.tenant.id,
      user: w.user.id,
      body: { runId: fresh.input.runId },
      idempotencyKey: command,
    });
    expect(replay.status).toBe(403);
  });
  it('AC-SC-03 计划前来源暂不可用登记退避，恢复后重走首次计划', async () => {
    const h = await setup(false);
    const blocked = await consumeRun({ ...h.deps, authorize: () => false }, h.input);
    expect(blocked).toMatchObject({ status: 'blocked', hasPlan: false });
    let now = new Date(SC_NOW.getTime() + 61_000);
    const deps = { ...h.deps, clock: () => now };
    const unavailable = vi.spyOn(h.port, 'loadRun').mockRejectedValueOnce(new Error('测试来源暂不可用'));
    await recoverSyncBatches(deps, w.tenant.id);
    unavailable.mockRestore();
    const state = await w.asTenant((tx) =>
      tx.execute(sql`SELECT status,auto_retry_count,block_reason
      FROM succession_sync_batches WHERE id=${blocked!.id}::uuid`),
    );
    expect(rowsOf(state)).toEqual([{ status: 'blocked', auto_retry_count: 1, block_reason: 'STORAGE_UNAVAILABLE' }]);
    now = new Date(now.getTime() + 5 * 60_000);
    await recoverSyncBatches(deps, w.tenant.id);
    const detail = await w.request('GET', `/sync-batches/${blocked!.id}`);
    expect(await detail.json()).toMatchObject({ status: 'completed', hasPlan: true });
  });
  it('SELF 目标在详情、计数、审计同样隐藏', async () => {
    const h = await setup();
    await w.setHead(std.orgB, std.head);
    await w.asTenant((tx) =>
      overrideSetting(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.user.id,
          key: 'succession.self_successors_visible',
          expectedRevision: 0,
          now: SC_NOW,
          commandId: randomUUID(),
        },
        false,
      ),
    );
    const userId = await w.userOf(std.head),
      api = tenantApi(w.db, { clock: () => SC_NOW });
    const detail = await api.request('GET', `/api/tenant/succession/sync-batches/${h.batch.id}`, {
      tenant: w.tenant.id,
      user: userId,
    });
    expect(detail.status).toBe(404);
    const spec = SUCCESSION_AUDIT.syncBatch!;
    if (spec.kind !== 'rows') throw new Error('审计谓词缺失');
    const predicate = spec.visible!(
      { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
      {
        objectId: sql`${h.batch.id}`,
        org: sql`NULL`,
        before: sql`NULL`,
        after: sql`NULL`,
        commandId: sql`NULL`,
      },
      { tenantId: w.tenant.id, userId },
    );
    const seen = await w.asTenant((tx) => tx.execute(sql`SELECT ${predicate} AS visible`));
    expect(rowsOf(seen)).toEqual([{ visible: false }]);
  });
});

interface BatchAudit {
  actor: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changes: { field: string; from: unknown; to: unknown }[];
}
async function batchAudit(id: string, phase: string) {
  return rowsOf<BatchAudit>(
    await w.asTenant((tx) =>
      tx.execute(sql`
    SELECT actor_user_id AS actor,"before","after",changes FROM audit_events
    WHERE tenant_id=${w.tenant.id}::uuid AND object_id=${id}
      AND action=${`succession.sync-batch.${phase}`} ORDER BY occurred_at,id`),
    ),
  );
}
function sameExecution(event: BatchAudit, actor: string | null, execution: number) {
  expect(event.actor).toBe(actor);
  expect(event.before.executionNo).toBe(execution);
  expect(event.after.executionNo).toBe(execution);
  expect(Object.keys(event.before).sort()).toEqual(Object.keys(event.after).sort());
  expect(event.changes.some((change) => change.field === 'executionNo')).toBe(false);
}
describe('第 1 轮审计正确性与明细 recovery 回归', () => {
  it('人工 sync 驱动、计划、完成与通知保留实际操作人和真实前后值，同键不重复通知审计', async () => {
    const h = await setup(false);
    const options = { body: { runId: h.input.runId }, idempotencyKey: randomUUID() };
    const response = await w.request('POST', '/sync', options);
    expect(response.status).toBe(202);
    const batch = (await response.json()) as { id: string };
    const event = (await batchAudit(batch.id, 'sync'))[0]!;
    expect(event.actor).toBe(w.user.id);
    expect(event.before).toMatchObject({ status: 'waiting', executionNo: null, autoRetryCount: 0, nextRetryAt: null });
    expect(event.after).toMatchObject({
      status: 'waiting',
      executionNo: null,
      autoRetryCount: 0,
      nextRetryAt: SC_NOW.toISOString(),
    });
    expect(Object.keys(event.before).sort()).toEqual(Object.keys(event.after).sort());
    for (const phase of ['plan', 'execute', 'complete', 'sync_done'])
      expect((await batchAudit(batch.id, phase))[0]!.actor, phase).toBe(w.user.id);
    expect((await w.request('POST', '/sync', options)).status).toBe(202);
    expect(await batchAudit(batch.id, 'sync_done')).toHaveLength(1);
  });
  it('人工 retry 记录原次数和阻塞原因，接管真实记录执行号 1→2', async () => {
    const h = await setup();
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_sync_batches
      SET status='blocked',block_reason='STORAGE_UNAVAILABLE',auto_retry_count=2 WHERE id=${h.batch.id}::uuid`),
    );
    h.port.advance(121);
    const response = await w.request('POST', `/sync-batches/${h.batch.id}/retry`, {
      ifMatch: h.batch.revision,
      body: {},
    });
    expect(response.status).toBe(202);
    const event = (await batchAudit(h.batch.id, 'retry'))[0]!;
    sameExecution(event, w.user.id, 1);
    expect(event.before).toMatchObject({ autoRetryCount: 2, blockReason: 'STORAGE_UNAVAILABLE' });
    expect(event.after).toMatchObject({ autoRetryCount: 0, blockReason: 'STORAGE_UNAVAILABLE' });
    const claim = (await batchAudit(h.batch.id, 'claim'))[0]!;
    expect(claim.actor).toBe(w.user.id);
    expect(claim.before).toMatchObject({ status: 'blocked', executionNo: 1 });
    expect(claim.after).toMatchObject({ status: 'executing', executionNo: 2 });
  });
  it('SA abort 已计划批次记本人操作，执行号保持 1，不制造空→1', async () => {
    const h = await setup();
    const response = await w.request('POST', `/sync-batches/${h.batch.id}/abort`, {
      ifMatch: h.batch.revision,
      body: {},
    });
    expect(response.status).toBe(200);
    const event = (await batchAudit(h.batch.id, 'terminated'))[0]!;
    sameExecution(event, w.user.id, 1);
    expect(event.before).toMatchObject({ status: 'executing', endReason: null });
    expect(event.after).toMatchObject({ status: 'terminated', endReason: 'aborted' });
  });
  it('自动恢复与项目重启清理仍记系统，执行号前后对称', async () => {
    const h = await setup();
    await h.port.supersede(h.input.runId);
    await recoverSyncBatches(h.deps, w.tenant.id);
    const event = (await batchAudit(h.batch.id, 'terminated'))[0]!;
    sameExecution(event, null, 1);
    expect(event.before.endReason).toBeNull();
    expect(event.after.endReason).toBe('superseded');
  });
  it('items 与 targets 在投影层统一输出 recovery，不暴露内部 retryable', async () => {
    const h = await setup();
    for (const retryable of [true, false]) {
      await w.asTenant(async (tx) => {
        await tx.execute(
          sql`UPDATE succession_sync_items SET retryable=${retryable} WHERE batch_id=${h.batch.id}::uuid`,
        );
        await tx.execute(
          sql`UPDATE succession_sync_targets SET retryable=${retryable} WHERE batch_id=${h.batch.id}::uuid`,
        );
      });
      for (const kind of ['items', 'targets']) {
        const response = await w.request('GET', `/sync-batches/${h.batch.id}/${kind}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: Record<string, unknown>[] };
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toHaveProperty('recovery', retryable ? 'retry_same_run' : 'none');
        expect(body.items[0]).not.toHaveProperty('retryable');
      }
    }
  });
});
