/** D1b：设计 §5.7 第 1～14 步；数据库与 SP-18 替身共同事务。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import type { AuthorizationRequest } from '../../apps/api/src/authorization.js';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { planSyncRun as consumeRun } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { syncFixture, FX } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { syncTestTransaction } from './AC-SC-sync-support.js';

const testDb = useTestDb();
let w: SuccessionWorld;
let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
let revision = 0;
const setting = (key: string, value: unknown, expectedRevision = 0) =>
  w.asTenant((tx) =>
    overrideSetting(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        key: `succession.${key}`,
        expectedRevision,
        now: SC_NOW,
        commandId: randomUUID(),
      },
      value,
    ),
  );
beforeAll(async () => {
  w = await successionWorld(testDb().db, 'sc-sync-plan');
  std = await w.standard();
  await setting('system_principal_user_id', w.user.id);
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO permission_profiles (tenant_id,code,name,source)
      VALUES (${w.tenant.id}::uuid,'standard_succession_runner','继任执行身份','standard') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_grants (tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles
      WHERE tenant_id=${w.tenant.id}::uuid AND code='standard_succession_runner' ON CONFLICT DO NOTHING`);
  });
});
afterEach(async () => {
  if (!w) return;
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL WHERE tenant_id=${w.tenant.id}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_batches SET status='terminated' WHERE tenant_id=${w.tenant.id}::uuid`);
  });
  await setting('sync_strategy', 'append', revision++);
});
function setup(options: { empty?: boolean; scopeExplicit?: boolean } = {}) {
  const source = syncFixture({ withEmptyObject: true });
  const original = source.runs![0]!;
  const runId = randomUUID();
  const nominations = original.nominations.map((n) => ({
    ...n,
    orgId: n.orgId ? std.orgA.id : null,
    positionId: n.positionId ? std.keyPosition.id : null,
    successorEmployeeId: std.successor1.id,
    readinessId: null,
    readinessCode: null,
  }));
  const header = {
    ...original.header,
    runId,
    actorUserId: w.user.id,
    ownerUserId: w.user.id,
    principalUserId: w.user.id,
    businessDate: SC_TODAY,
    scopeExplicit: options.scopeExplicit ?? false,
  };
  const port = createInMemoryTalentReviewSyncPort({
    ...source,
    tenantId: w.tenant.id,
    runs: [
      {
        ...original,
        header,
        nominations: options.empty ? [] : nominations,
        orgHealth: original.orgHealth.map((h) => ({
          ...h,
          orgId: h.orgId === FX.g1 ? std.orgA.id : std.orgB.id,
          status: 'not_provided' as const,
          levelId: null,
          levelCode: null,
        })),
      },
    ],
  });
  const input = { tenantId: w.tenant.id, runId, leaseOwner: randomUUID() };
  const key = { tenantId: w.tenant.id, runId, consumer: 'succession' as const };
  const deps = {
    db: testDb().db,
    port,
    clock: () => SC_NOW,
    authorize: (_request: AuthorizationRequest) => true,
    transaction: syncTestTransaction(testDb().db, w.tenant.id, port),
  };
  const outcomes = async () => (await deps.transaction((tx) => port.getOutcomes(tx, key))).items;
  return { deps, port, input, key, outcomes };
}
const batch = async (runId: string) =>
  rowsOf<Record<string, unknown>>(
    await w.asTenant((tx) => tx.execute(sql`SELECT * FROM succession_sync_batches WHERE source_run_id=${runId}::uuid`)),
  )[0]!;
const count = async (table: string, batchId: unknown) =>
  rowsOf<{ n: number }>(
    await w.asTenant((tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM ${sql.identifier(table)} WHERE batch_id=${String(batchId)}::uuid`),
    ),
  )[0]!.n;

describe('AC-SC-03-04-sync D1b 首次计划', () => {
  it('步骤 1～14：冻结计划、一次 registerTargets、页 0 证明、屏障，重投不重复 begin', async () => {
    const h = setup();
    const register = vi.spyOn(h.port, 'registerTargets');
    const begin = vi.spyOn(h.port, 'beginConsumption');
    const record = vi.spyOn(h.port, 'recordOutcome');
    await consumeRun(h.deps, h.input);
    const b = await batch(h.input.runId);
    expect(b).toMatchObject({ status: 'executing', has_plan: true, business_date: SC_TODAY, execution_no: 1 });
    expect(await count('succession_sync_items', b['id'])).toBe(3);
    expect(await count('succession_sync_targets', b['id'])).toBe(2);
    expect(register).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    const call = register.mock.calls[0]![1];
    expect(call.planCommandId).toBe(`${h.input.runId}:succession:1:0`);
    expect(call.planOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowKind: 'nomination', rowId: FX.n3, status: 'skipped' }),
        expect.objectContaining({ rowKind: 'object', rowId: FX.o3, status: 'skipped' }),
      ]),
    );
    expect(
      await h.deps.transaction((tx) => h.port.getPageCommit(tx, { ...h.key, pageCommandId: call.planCommandId })),
    ).toMatchObject({ kind: 'plan', executionNo: 1 });
    await consumeRun(h.deps, h.input);
    expect(begin).toHaveBeenCalledTimes(1);
    const response = await w.request('POST', '/records', {
      ifMatch: 0,
      body: {
        successionType: 'org',
        targetOrgId: std.orgA.id,
        successorEmployeeId: std.successor2.id,
        backupType: 'principal',
        startDate: SC_TODAY,
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'TARGET_SYNC_IN_PROGRESS' } } });
  });
  it('步骤 3：另一 run 持互斥时只记 waiting，不能进入 begin', async () => {
    const first = setup();
    await consumeRun(first.deps, first.input);
    const next = setup();
    const begin = vi.spyOn(next.port, 'beginConsumption');
    await consumeRun(next.deps, next.input);
    expect(await batch(next.input.runId)).toMatchObject({ status: 'waiting', block_reason: 'BATCH_IN_PROGRESS' });
    expect(begin).not.toHaveBeenCalled();
  });
  it('步骤 14：零执行目标同事务完成，登记空集并释放互斥；终态重投幂等', async () => {
    const h = setup({ empty: true });
    const complete = vi.spyOn(h.port, 'completeConsumption');
    await consumeRun(h.deps, h.input);
    expect(await batch(h.input.runId), JSON.stringify(await batch(h.input.runId))).toMatchObject({
      status: 'completed',
      result: 'succeeded',
      has_plan: true,
    });
    expect((await h.outcomes()).every((r) => r.status === 'skipped')).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    await consumeRun(h.deps, h.input);
    expect(complete).toHaveBeenCalledTimes(1);
    await expect(consumeRun(h.deps, { ...h.input, requesterUserId: w.user.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'RUN_NOT_RETRYABLE' },
    });
    const next = setup();
    await consumeRun(next.deps, next.input);
    expect(await batch(next.input.runId)).toMatchObject({ status: 'executing' });
  });
  it('步骤 6：隐式范围覆盖回滚后 abort(null,new_run)，无计划/互斥，通知原触发人', async () => {
    await setting('sync_strategy', 'overwrite_in_scope', revision++);
    const h = setup();
    const abort = vi.spyOn(h.port, 'abortConsumption');
    await consumeRun(h.deps, h.input);
    const b = await batch(h.input.runId);
    expect(b).toMatchObject({ status: 'rejected', has_plan: false, end_reason: 'SCOPE_REQUIRED' });
    expect(abort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        executionNo: null,
        code: 'SCOPE_REQUIRED',
        recovery: 'new_run',
      }),
    );
    expect(await count('succession_sync_items', b['id'])).toBe(0);
    expect(await count('succession_notifications', b['id'])).toBe(1);
    expect((await h.outcomes()).every((r) => r.status === 'aborted')).toBe(true);
  });
  it('步骤 7：源失效整事务回滚，恢复后第一次消费执行号仍为 1', async () => {
    const h = setup();
    const source = vi.spyOn(h.port, 'authorizeSourceRead');
    source.mockResolvedValueOnce({
      ok: false,
      runStatus: 'frozen',
      reason: 'OWNER_UNAVAILABLE',
      forbidden: { objectIds: [], fields: {}, sources: [], orgIds: [], orgFields: {} },
    });
    await consumeRun(h.deps, h.input);
    expect(await batch(h.input.runId)).toMatchObject({ status: 'blocked', has_plan: false });
    await consumeRun(h.deps, h.input);
    expect(await batch(h.input.runId)).toMatchObject({ status: 'executing', execution_no: 1 });
  });
  it('步骤 8：写主体撤销执行身份不能留下计划', async () => {
    const h = setup();
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE permission_grants SET status='revoked'
      WHERE tenant_id=${w.tenant.id}::uuid AND user_id=${w.user.id}::uuid`),
    );
    try {
      await consumeRun(h.deps, h.input);
      expect(await batch(h.input.runId)).toMatchObject({ status: 'blocked', block_reason: 'PRINCIPAL_UNAVAILABLE' });
    } finally {
      await w.asTenant((tx) =>
        tx.execute(sql`UPDATE permission_grants SET status='active'
        WHERE tenant_id=${w.tenant.id}::uuid AND user_id=${w.user.id}::uuid`),
      );
    }
  });
  it('步骤 13：提交返回未知时按同执行号页 0 证明回查，不重复登记', async () => {
    const h = setup();
    const transaction = h.deps.transaction;
    let fail = true;
    h.deps.transaction = async (work) => {
      const value = await transaction(work);
      if (fail) {
        fail = false;
        throw new Error('模拟 COMMIT 回包丢失');
      }
      return value;
    };
    const register = vi.spyOn(h.port, 'registerTargets');
    await consumeRun(h.deps, h.input);
    expect(await batch(h.input.runId)).toMatchObject({ has_plan: true, status: 'executing' });
    expect(register).toHaveBeenCalledTimes(1);
  });
  it.runIf(Boolean(process.env['TEST_DATABASE_URL']))('真 PG：并发两次 consumeRun 只有一个进入 begin', async () => {
    const first = setup();
    const next = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = first.port.beginConsumption.bind(first.port);
    vi.spyOn(first.port, 'beginConsumption').mockImplementation(async (tx, input) => {
      entered();
      await gate;
      return original(tx, input);
    });
    const secondBegin = vi.spyOn(next.port, 'beginConsumption');
    const a = consumeRun(first.deps, first.input);
    await ready;
    const b = consumeRun(next.deps, next.input);
    try {
      await waitForBlocked(testDb().db, 1);
    } finally {
      release();
    }
    await Promise.all([a, b]);
    expect(secondBegin).not.toHaveBeenCalled();
    expect(await batch(next.input.runId)).toMatchObject({ status: 'waiting' });
  });
});

it.each(['HEALTH_LEVEL_UNKNOWN', 'HEALTH_LEVEL_DISABLED', 'SOURCE_REVOKED'] as const)(
  'AC-SC-04 健康度计划失败 %s，零目标完成 partial，不误登记 target',
  async (code) => {
    const h = setup({ empty: true });
    const id = randomUUID();
    if (code === 'HEALTH_LEVEL_DISABLED')
      await w.asTenant((tx) =>
        tx.execute(sql`
      INSERT INTO succession_health_levels (id,tenant_id,code,name,color,display_order,enabled)
      VALUES (${id}::uuid,${w.tenant.id}::uuid,${id},${id},'#3366FF',1,false)`),
      );
    const original = await h.deps.transaction((tx) => h.port.listRunOrgHealth(tx, h.key));
    vi.spyOn(h.port, 'listRunOrgHealth').mockResolvedValue(
      original.map((row) =>
        row.orgId !== std.orgA.id
          ? row
          : {
              ...row,
              levelId: id,
              status: 'value',
              levelCode: null,
            },
      ),
    );
    if (code === 'SOURCE_REVOKED') h.port.revoke({ fieldCodes: ['levelId'] });
    const register = vi.spyOn(h.port, 'registerTargets');
    await consumeRun(h.deps, h.input);
    expect(await batch(h.input.runId)).toMatchObject({ status: 'completed', result: 'partial' });
    expect(register.mock.calls[0]![1].targets).toEqual([]);
    expect(await h.outcomes()).toContainEqual(
      expect.objectContaining({
        rowKind: 'org_health',
        rowId: std.orgA.id,
        status: 'failed',
        errorCode: code,
        recovery: 'none',
      }),
    );
  },
);
it('AC-SC-03 原触发人范围撤回为 C 类；调用人范围不足保持原状态', async () => {
  const h = setup();
  const actor = await w.userOf(std.head);
  const original = h.port.loadRun.bind(h.port);
  vi.spyOn(h.port, 'loadRun').mockImplementation(async (tx, key) => ({
    ...(await original(tx, key))!,
    actorUserId: actor,
  }));
  h.deps.authorize = (request) => request.userId !== actor;
  await consumeRun(h.deps, h.input);
  expect(await batch(h.input.runId)).toMatchObject({ status: 'rejected', end_reason: 'ACTOR_SCOPE_EXCEEDED' });
  const next = setup();
  next.deps.authorize = (request) => request.userId !== actor;
  await expect(consumeRun(next.deps, { ...next.input, requesterUserId: actor })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    details: { reason: 'BATCH_SCOPE_EXCEEDS_REQUESTER' },
  });
  expect(await batch(next.input.runId)).toBeUndefined();
  expect((await next.outcomes()).every((r) => r.status === 'pending')).toBe(true);
});
it('AC-SC-03 覆盖目标部分提名失败，合法提名同组失败，旧集合保持', async () => {
  await setting('sync_strategy', 'overwrite', revision++);
  const h = setup();
  const original = h.port.listRunNominations.bind(h.port);
  vi.spyOn(h.port, 'listRunNominations').mockImplementation(async (tx, input) => {
    const page = await original(tx, input);
    return {
      ...page,
      items: page.items.map((n) => ({
        ...n,
        kind: 'org',
        positionId: null,
        orgId: std.orgA.id,
        readinessId: n.nominationId === FX.n2 ? randomUUID() : null,
      })),
    };
  });
  const old = await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: std.successor2.id });
  await consumeRun(h.deps, h.input);
  expect(await batch(h.input.runId)).toMatchObject({ status: 'completed', result: 'partial' });
  expect(await h.outcomes()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rowId: FX.n2, errorCode: 'READINESS_UNKNOWN' }),
      expect.objectContaining({ rowId: FX.n1, errorCode: 'TARGET_PARTIAL_NOMINATIONS' }),
      expect.objectContaining({ rowId: FX.o1, errorCode: 'NOMINATIONS_FAILED' }),
    ]),
  );
  expect(
    rowsOf(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT end_date::text FROM succession_records
    WHERE id=${old}::uuid`),
      ),
    ),
  ).toEqual([{ end_date: '9999-12-31' }]);
});
it('AC-SC-03 源对象撤权覆盖 R10 聚合；无计划提交前不留互斥', async () => {
  const h = setup();
  h.port.revoke({ objectIds: [FX.o1] });
  await consumeRun(h.deps, h.input);
  expect(await h.outcomes()).toContainEqual(
    expect.objectContaining({
      rowKind: 'object',
      rowId: FX.o1,
      errorCode: 'SOURCE_REVOKED',
      errorParams: { scope: 'object', ref: FX.o1 },
    }),
  );
});
it('AC-SC-03 显式空范围不扩大 delete_only；范围覆盖保留旧集合快照', async () => {
  const old = await w.insertRecord({ type: 'org', targetId: std.orgB.id, successorId: std.successor2.id });
  await setting('sync_strategy', 'overwrite_in_scope', revision++);
  const empty = setup({ empty: true, scopeExplicit: true });
  await consumeRun(empty.deps, empty.input);
  expect(await batch(empty.input.runId)).toMatchObject({ status: 'completed' });
  expect(await count('succession_sync_targets', (await batch(empty.input.runId))['id'])).toBe(0);
  const h = setup({ empty: true, scopeExplicit: true });
  const load = h.port.loadRun.bind(h.port);
  vi.spyOn(h.port, 'loadRun').mockImplementation(async (tx, key) => ({
    ...(await load(tx, key))!,
    scopeOrgIds: [std.orgB.id],
  }));
  await consumeRun(h.deps, h.input);
  const b = await batch(h.input.runId);
  const plans = rowsOf(
    await w.asTenant((tx) =>
      tx.execute(sql`SELECT action,old_record_ids
    FROM succession_sync_targets WHERE batch_id=${String(b['id'])}::uuid`),
    ),
  );
  expect(plans).toEqual([expect.objectContaining({ action: 'delete_only', old_record_ids: [old] })]);
});
it('AC-SC-03 已终止对象全跳过，应在首次计划内完成', async () => {
  const h = setup();
  const list = h.port.listRunObjects.bind(h.port);
  vi.spyOn(h.port, 'listRunObjects').mockImplementation(async (tx, key) => {
    const page = await list(tx, key);
    return { ...page, items: page.items.map((o) => ({ ...o, status: 'terminated', blockReason: 'terminated' })) };
  });
  await consumeRun(h.deps, h.input);
  expect(await batch(h.input.runId)).toMatchObject({ status: 'completed' });
  expect((await h.outcomes()).every((r) => r.status === 'skipped')).toBe(true);
});

it('AC-SC-03 步骤 4/5：superseded 本地终止；持租约者退出且不改回执', async () => {
  const old = setup();
  await old.port.supersede(old.input.runId);
  const abort = vi.spyOn(old.port, 'abortConsumption');
  await consumeRun(old.deps, old.input);
  expect(await batch(old.input.runId)).toMatchObject({ status: 'terminated', end_reason: 'superseded' });
  expect(abort).not.toHaveBeenCalled();
  const h = setup();
  await h.deps.transaction((tx) =>
    h.port.beginConsumption(tx, { ...h.key, leaseOwner: '另一个 worker', leaseSeconds: 60 }),
  );
  await consumeRun(h.deps, h.input);
  expect(await batch(h.input.runId)).toBeUndefined();
  expect((await h.outcomes()).every((r) => r.status === 'pending')).toBe(true);
});
it('AC-SC-04 启用等级按 code 映射到 B2b ID；empty 健康度保留清空计划', async () => {
  const h = setup({ empty: true });
  const id = randomUUID();
  await w.asTenant((tx) =>
    tx.execute(sql`INSERT INTO succession_health_levels
    (id,tenant_id,code,name,color,display_order,enabled)
    VALUES (${id}::uuid,${w.tenant.id}::uuid,${id},${id},'#3366FF',2,true)`),
  );
  const original = await h.deps.transaction((tx) => h.port.listRunOrgHealth(tx, h.key));
  vi.spyOn(h.port, 'listRunOrgHealth').mockResolvedValue(
    original.map((row, i) => ({ ...row, levelId: null, levelCode: i ? null : id, status: i ? 'empty' : 'value' })),
  );
  await consumeRun(h.deps, h.input);
  const b = await batch(h.input.runId);
  expect(b).toMatchObject({ status: 'executing' });
  expect(
    rowsOf(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT health_status,health_level_id FROM succession_sync_targets
    WHERE batch_id=${String(b['id'])}::uuid ORDER BY health_status`),
      ),
    ),
  ).toEqual([
    { health_status: 'empty', health_level_id: null },
    { health_status: 'value', health_level_id: id },
  ]);
});
it('AC-SC-03 unknown 证明执行号错误不得认作提交成功', async () => {
  const h = setup();
  const transaction = h.deps.transaction;
  let fail = true;
  h.deps.transaction = async (work) => {
    const value = await transaction(work);
    if (fail) {
      fail = false;
      throw new Error('模拟 COMMIT 回包丢失');
    }
    return value;
  };
  const get = h.port.getPageCommit.bind(h.port);
  vi.spyOn(h.port, 'getPageCommit').mockImplementation(async (tx, key) => {
    const proof = await get(tx, key);
    return proof ? { ...proof, executionNo: proof.executionNo + 1 } : null;
  });
  await expect(consumeRun(h.deps, h.input)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});

it('AC-SC-03 真实权限解析：执行身份没有对象权限/数据范围时 fail-closed', async () => {
  const h = setup();
  await consumeRun({ ...h.deps, authorize: createPermissionAuthorizer(testDb().db) }, h.input);
  expect(await batch(h.input.runId)).toMatchObject({
    status: 'blocked',
    block_reason: 'PRINCIPAL_UNAVAILABLE',
    has_plan: false,
  });
});
it('AC-SC-03 页 0 未提交时同命令重试，提名与目标没有重复', async () => {
  const h = setup();
  const register = h.port.registerTargets.bind(h.port);
  const spy = vi.spyOn(h.port, 'registerTargets');
  spy.mockRejectedValueOnce(new Error('模拟提交前存储中断'));
  spy.mockImplementation((tx, input) => register(tx, input));
  await consumeRun(h.deps, h.input);
  expect(spy.mock.calls.map((call) => call[1].planCommandId)).toEqual([
    `${h.input.runId}:succession:1:0`,
    `${h.input.runId}:succession:1:0`,
  ]);
  expect(await count('succession_sync_items', (await batch(h.input.runId))['id'])).toBe(3);
});
it.runIf(Boolean(process.env['TEST_DATABASE_URL']))(
  'AC-SC-03 真 PG：consumeRun 持目标锁时 A2 等待，提交后 409',
  async () => {
    const h = setup();
    let enter!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const register = h.port.registerTargets.bind(h.port);
    vi.spyOn(h.port, 'registerTargets').mockImplementation(async (tx, input) => {
      enter();
      await gate;
      return register(tx, input);
    });
    const plan = consumeRun(h.deps, h.input);
    await ready;
    const write = w.request('POST', '/records', {
      ifMatch: 0,
      body: {
        successionType: 'org',
        targetOrgId: std.orgA.id,
        successorEmployeeId: std.successor2.id,
        backupType: 'principal',
        startDate: SC_TODAY,
      },
    });
    try {
      await waitForBlocked(testDb().db, 1);
    } finally {
      release();
    }
    await plan;
    const response = await write;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'TARGET_SYNC_IN_PROGRESS' } } });
  },
);

it('AC-SC-03 步骤 4：非同步触发 run 在 begin 前 new_run 中止', async () => {
  const h = setup();
  const load = h.port.loadRun.bind(h.port);
  vi.spyOn(h.port, 'loadRun').mockImplementation(async (tx, key) => ({
    ...(await load(tx, key))!,
    trigger: 'snapshot' as 'sync_requested',
  })); // 验收历史/异常来源，不改变端口定义。
  const begin = vi.spyOn(h.port, 'beginConsumption');
  await consumeRun(h.deps, h.input);
  expect(await batch(h.input.runId)).toMatchObject({ status: 'rejected', end_reason: 'UNSUPPORTED_TRIGGER' });
  expect(begin).not.toHaveBeenCalled();
  expect((await h.outcomes()).every((r) => r.status === 'aborted')).toBe(true);
});
it('AC-SC-03 步骤 7：对象分两页逐页授权，冻结的提名字段撤权写永久失败', async () => {
  const h = setup();
  const list = h.port.listRunObjects.bind(h.port);
  const objects = vi.spyOn(h.port, 'listRunObjects').mockImplementation(async (tx, key) => {
    const all = await list(tx, { tenantId: key.tenantId, runId: key.runId, limit: key.limit });
    return key.after ? { items: all.items.slice(1), next: null } : { items: all.items.slice(0, 1), next: '第二页' };
  });
  const authorize = vi.spyOn(h.port, 'authorizeSourceRead');
  h.port.revoke({ fieldCodes: ['readinessId'] });
  await consumeRun(h.deps, h.input);
  expect(objects.mock.calls.map((call) => call[1].limit)).toEqual([500, 500]);
  expect(authorize.mock.calls.slice(0, 2).map((call) => call[1].page.objectIds?.length)).toEqual([1, 2]);
  expect(await h.outcomes()).toContainEqual(
    expect.objectContaining({
      rowKind: 'nomination',
      rowId: FX.n1,
      errorCode: 'SOURCE_REVOKED',
      recovery: 'none',
      errorParams: { scope: 'field', ref: 'readinessId' },
    }),
  );
});

it('AC-SC-03 原触发人与调用人为同一账号时，调用阶段撤权仍返回 403 并回滚', async () => {
  const h = setup();
  let scopes = 0;
  h.deps.authorize = (request) => request.action !== 'data.scope.all' || ++scopes <= 4;
  await expect(consumeRun(h.deps, { ...h.input, requesterUserId: w.user.id })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    details: { reason: 'BATCH_SCOPE_EXCEEDS_REQUESTER' },
  });
  expect(await batch(h.input.runId)).toBeUndefined();
  expect((await h.outcomes()).every((r) => r.status === 'pending')).toBe(true);
});
