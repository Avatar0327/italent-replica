/** D2：真实 SQL 业务写入 + SP-18 共同事务替身；旧实现停在计划，以下验收必须先红。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle, type Tx } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRun, consumeSyncOutbox } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { syncFixture, FX } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { syncTestTransaction } from './AC-SC-sync-support.js';
import { SyncPortError } from '../../apps/api/src/modules/talent-review/sync-port.js';
import * as audit from '../../apps/api/src/audit/record.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';

let handle: DbHandle;
afterAll(async () => {
  await handle?.close();
});
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
  handle = await createTestDb();
  w = await successionWorld(handle.db, 'sc-sync-execute');
  std = await w.standard();
  await setting('system_principal_user_id', w.user.id);
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO permission_profiles (tenant_id,code,name,source)
      VALUES (${w.tenant.id}::uuid,'standard_succession_runner','继任执行身份','standard') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_grants (tenant_id,user_id,profile_id)
      SELECT ${w.tenant.id}::uuid,${w.user.id}::uuid,id FROM permission_profiles
      WHERE tenant_id=${w.tenant.id}::uuid AND code='standard_succession_runner' ON CONFLICT DO NOTHING`);
  });
}, 180_000);
async function setup(strategy = 'append', empty = false, position = false) {
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL WHERE tenant_id=${w.tenant.id}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_batches SET status='terminated' WHERE tenant_id=${w.tenant.id}::uuid`);
  });
  await setting('sync_strategy', strategy, revision++);
  const org = await w.org(`执行目标${revision}`, undefined, { establishedOn: '2026-09-30' });
  const target = position ? await w.position(org.id, `目标职位${revision}`) : org;
  const kind = position ? ('position' as const) : ('org' as const);
  const oldId = await w.insertRecord({ type: kind, targetId: target.id, successorId: std.head.id });
  const fixture = syncFixture();
  const original = fixture.runs![0]!;
  const runId = randomUUID();
  const nominations = empty
    ? []
    : [0, 1].map((i) => ({
        ...original.nominations[0]!,
        nominationId: i ? FX.n2 : FX.n1,
        objectId: i ? FX.o2 : FX.o1,
        kind,
        orgId: position ? null : org.id,
        positionId: position ? target.id : null,
        successorEmployeeId: i ? std.successor2.id : std.successor1.id,
        readinessId: null,
        readinessCode: null,
      }));
  const port = createInMemoryTalentReviewSyncPort({
    ...fixture,
    tenantId: w.tenant.id,
    runs: [
      {
        ...original,
        header: {
          ...original.header,
          runId,
          actorUserId: w.user.id,
          ownerUserId: w.user.id,
          principalUserId: w.user.id,
          businessDate: SC_TODAY,
          scopeExplicit: true,
          scopeOrgIds: [org.id],
        },
        nominations,
        orgHealth: [],
      },
    ],
  });
  const input = { tenantId: w.tenant.id, runId, leaseOwner: randomUUID() };
  const key = { tenantId: w.tenant.id, runId, consumer: 'succession' as const };
  const deps = {
    db: w.db,
    port,
    clock: () => SC_NOW,
    authorize: () => true,
    transaction: syncTestTransaction(w.db, w.tenant.id, port),
  };
  const records = () =>
    w.asTenant(async (tx) =>
      rowsOf<Record<string, unknown>>(
        await tx.execute(sql`
    SELECT id,successor_employee_id,end_date::text,readiness_id,revision,source_kind,source_batch_id
    FROM succession_records WHERE tenant_id=${w.tenant.id}::uuid
    AND coalesce(target_org_id,target_position_id)=${target.id}::uuid ORDER BY id`),
      ),
    );
  const outcomes = async () => (await deps.transaction((tx) => port.getOutcomes(tx, key))).items;
  return { deps, port, input, key, org, target, oldId, records, outcomes };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const hookErrors: unknown[] = [];
afterEach(() => {
  const errors = hookErrors.splice(0);
  if (errors.length) throw errors[0];
});
async function fixtureHook(work: () => Promise<void> | void) {
  try {
    await work();
  } catch (error) {
    hookErrors.push(error);
    throw error;
  }
}
function afterPlan(h: Harness, work: (tx: Tx) => Promise<void> | void) {
  const register = h.port.registerTargets.bind(h.port);
  vi.spyOn(h.port, 'registerTargets').mockImplementation(async (tx, input) => {
    const result = await register(tx, input);
    await fixtureHook(() => work(tx));
    return result;
  });
}
function afterPlanCommit(h: Harness, work: () => Promise<void>) {
  let planned = false;
  afterPlan(h, () => {
    planned = true;
  });
  const transaction = h.deps.transaction;
  h.deps.transaction = async (job) => {
    const value = await transaction(job);
    if (planned) {
      planned = false;
      await fixtureHook(work);
    }
    return value;
  };
}

describe('AC-SC-03-04-sync D2 执行与终结', () => {
  it.each(['append', 'overwrite', 'overwrite_in_scope', 'delete_only'])(
    '%s：完整消费结束，保留 / 替换旧集合，delete_only 不遗漏回执',
    async (strategy) => {
      const h = await setup(strategy === 'delete_only' ? 'overwrite_in_scope' : strategy, strategy === 'delete_only');
      const result = await consumeRun(h.deps, h.input);
      expect(result).toMatchObject({ status: 'completed', result: 'succeeded', nextPageNo: 2 });
      const rows = await h.records();
      expect(rows.find((r) => r.id === h.oldId)?.end_date).toBe(strategy === 'append' ? '9999-12-31' : SC_TODAY);
      expect(rows.filter((r) => r.end_date === '9999-12-31')).toHaveLength(
        strategy === 'delete_only' ? 0 : strategy === 'append' ? 3 : 2,
      );
      expect((await h.outcomes()).find((r) => r.rowKind === 'target')).toMatchObject({ status: 'synced' });
      expect((await h.outcomes()).some((r) => r.status === 'pending')).toBe(false);
    },
  );
  it.each(['object', 'field', 'source'] as const)(
    '执行期 %s 撤权：覆盖整组保持旧集合，R6 / R10 分别定码',
    async (scope) => {
      const h = await setup('overwrite');
      const before = await h.records();
      const register = h.port.registerTargets.bind(h.port);
      vi.spyOn(h.port, 'registerTargets').mockImplementation(async (tx, input) => {
        const result = await register(tx, input);
        if (scope === 'field') {
          const authorize = h.port.authorizeSourceRead.bind(h.port);
          vi.spyOn(h.port, 'authorizeSourceRead').mockImplementation(async (pageTx, pageInput) => {
            const authorization = await authorize(pageTx, pageInput);
            return {
              ...authorization,
              forbidden: { ...authorization.forbidden, fields: { [FX.o1]: ['readinessId'] } },
            };
          });
        } else {
          h.port.revoke(
            scope === 'object' ? { objectIds: [FX.o1] } : { sources: [{ objectId: FX.o1, source: 'current_project' }] },
          );
        }
        return result;
      });
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
      expect(await h.records()).toEqual(before);
      const rows = await h.outcomes();
      expect(rows.find((r) => r.rowId === FX.n1)).toMatchObject({
        errorCode: 'SOURCE_REVOKED',
        errorParams: { scope },
      });
      expect(rows.find((r) => r.rowId === FX.n2)).toMatchObject({
        errorCode: 'TARGET_PARTIAL_NOMINATIONS',
        recovery: 'none',
      });
      expect(rows.find((r) => r.rowId === FX.o1)).toMatchObject({
        errorCode: scope === 'object' ? 'SOURCE_REVOKED' : 'NOMINATIONS_FAILED',
        recovery: 'none',
      });
    },
  );
  it('页外续租、页首断言、执行页提交后才独立终结；重投不重复写', async () => {
    const h = await setup();
    const renew = vi.spyOn(h.port, 'renewLease');
    const active = vi.spyOn(h.port, 'assertExecutionActive');
    const record = vi.spyOn(h.port, 'recordOutcome');
    const complete = vi.spyOn(h.port, 'completeConsumption');
    expect(
      await consumeSyncOutbox(
        h.deps,
        { tenantId: h.input.tenantId, payload: { runId: h.input.runId } },
        h.input.leaseOwner,
      ),
    ).toMatchObject({ status: 'completed' });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalled();
    expect(renew.mock.calls[0]![0]).not.toBe(record.mock.calls[0]![0]);
    expect(complete.mock.calls[0]![0]).not.toBe(record.mock.calls[0]![0]);
    expect(active.mock.invocationCallOrder[0]).toBeLessThan(record.mock.invocationCallOrder[0]!);
    const before = await h.records();
    await consumeRun(h.deps, h.input);
    expect(await h.records()).toEqual(before);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it.each(['append', 'overwrite'])('%s：已有同继任者记录返回 exists / updated，不重复插入', async (strategy) => {
    const h = await setup(strategy);
    const readiness = await w.readiness(`原准备度${strategy}`);
    const id = await w.insertRecord({
      type: 'org',
      targetId: h.org.id,
      successorId: std.successor1.id,
      readinessId: readiness.id,
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed' });
    const row = (await h.records()).find((r) => r.id === id)!;
    expect(row).toMatchObject({
      readiness_id: strategy === 'append' ? readiness.id : null,
      revision: strategy === 'append' ? 1 : 2,
    });
  });
  it('append 撤源权只失败受影响的提名，合法行照常写入', async () => {
    const h = await setup();
    afterPlan(h, () => h.port.revoke({ objectIds: [FX.o1] }));
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect((await h.records()).map((r) => r.successor_employee_id).sort()).toEqual(
      [std.head.id, std.successor2.id].sort(),
    );
    expect((await h.outcomes()).find((r) => r.rowId === FX.n2)).toMatchObject({ status: 'synced' });
  });
  it('锁内目标停用：目标与 planned 提名同码，旧集合保持', async () => {
    const h = await setup('overwrite');
    const before = await h.records();
    afterPlanCommit(h, async () => {
      const response = await w.patchOrg(h.org, { enabled: false, effectiveDate: SC_TODAY });
      expect(response.status).toBe(200);
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect(await h.records()).toEqual(before);
    expect((await h.outcomes()).filter((r) => ['target', 'nomination'].includes(r.rowKind))).toEqual(
      expect.arrayContaining([expect.objectContaining({ errorCode: 'TARGET_NOT_FOUND', recovery: 'none' })]),
    );
    expect(
      (await h.outcomes()).filter((r) => r.rowKind === 'nomination').every((r) => r.errorCode === 'TARGET_NOT_FOUND'),
    ).toBe(true);
  });
  // F-102：计划提交后源对象撤权与目标组织停用同时发生，提名与对象对同一撤权给出同一原因（SP-14 R6，设计 §5.7）。
  it.each(['append', 'overwrite'])('%s：撤源权与目标停用交错，提名与对象回执同为 SOURCE_REVOKED', async (strategy) => {
    const h = await setup(strategy);
    const before = await h.records();
    afterPlanCommit(h, async () => {
      h.port.revoke({ objectIds: [FX.o1] });
      expect((await w.patchOrg(h.org, { enabled: false, effectiveDate: SC_TODAY })).status).toBe(200);
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect(await h.records()).toEqual(before);
    const rows = await h.outcomes();
    const revoked = { errorCode: 'SOURCE_REVOKED', errorParams: { scope: 'object', ref: FX.o1 }, recovery: 'none' };
    expect(rows.find((r) => r.rowId === FX.n1)).toMatchObject(revoked);
    expect(rows.find((r) => r.rowId === FX.o1)).toMatchObject(revoked);
    // 目标行仍是目标级原因；未撤权的提名随目标同码。
    expect(rows.find((r) => r.rowKind === 'target')).toMatchObject({ errorCode: 'TARGET_NOT_FOUND' });
    expect(rows.find((r) => r.rowId === FX.n2)).toMatchObject({ errorCode: 'TARGET_NOT_FOUND', recovery: 'none' });
    expect(rows.find((r) => r.rowId === FX.o2)).toMatchObject({ errorCode: 'NOMINATIONS_FAILED' });
    // 错误报告（逐行失败明细）：同一对象下的提名与对象行原因一致。
    const report = rows
      .filter((r) => r.status === 'failed' && [FX.n1, FX.o1].includes(r.rowId))
      .map((r) => r.errorCode);
    expect(report).toEqual(['SOURCE_REVOKED', 'SOURCE_REVOKED']);
  });
  it('对照：仅目标停用时提名与对象回执按 TARGET_NOT_FOUND / R10 聚合', async () => {
    const h = await setup('overwrite');
    afterPlanCommit(h, async () => {
      expect((await w.patchOrg(h.org, { enabled: false, effectiveDate: SC_TODAY })).status).toBe(200);
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    const rows = await h.outcomes();
    for (const id of [FX.n1, FX.n2])
      expect(rows.find((r) => r.rowId === id)).toMatchObject({ errorCode: 'TARGET_NOT_FOUND', recovery: 'none' });
    for (const id of [FX.o1, FX.o2])
      expect(rows.find((r) => r.rowId === id)).toMatchObject({
        errorCode: 'NOMINATIONS_FAILED',
        errorParams: { codes: ['TARGET_NOT_FOUND'] },
      });
  });
  it.each(['source', 'write'])('页级 %s 授权失效整页回滚，保留计划与屏障，不 abort', async (kind) => {
    const h = await setup('overwrite');
    const before = await h.records();
    afterPlan(h, () => {
      if (kind === 'source') h.port.revoke({ owner: true });
      else h.deps.authorize = () => false;
    });
    const abort = vi.spyOn(h.port, 'abortConsumption');
    expect(await consumeRun(h.deps, h.input)).toMatchObject({
      status: 'blocked',
      hasPlan: true,
      blockReason: kind === 'source' ? 'OWNER_UNAVAILABLE' : 'PRINCIPAL_UNAVAILABLE',
    });
    expect(await h.records()).toEqual(before);
    expect(abort).not.toHaveBeenCalled();
    const response = await w.request('DELETE', `/records/${h.oldId}`, { ifMatch: 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'TARGET_SYNC_IN_PROGRESS' } } });
  });
  it('租约在续租后页首前过期：断言停止，不写批次或业务', async () => {
    const h = await setup();
    const renew = h.port.renewLease.bind(h.port);
    vi.spyOn(h.port, 'renewLease').mockImplementation(async (tx, input) => {
      const state = await renew(tx, input);
      h.port.advance(121);
      return state;
    });
    const before = await h.records();
    const record = vi.spyOn(h.port, 'recordOutcome');
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'executing', nextPageNo: 1 });
    expect(await h.records()).toEqual(before);
    expect(record).not.toHaveBeenCalled();
  });
  it('租约已过期并被真实接管：旧 worker 续租停止，不改批次', async () => {
    const h = await setup();
    afterPlanCommit(h, async () => {
      h.port.advance(121);
      expect(
        await h.deps.transaction((tx) =>
          h.port.beginConsumption(tx, {
            ...h.key,
            leaseOwner: randomUUID(),
            leaseSeconds: 120,
          }),
        ),
      ).toMatchObject({ executionNo: 2 });
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'executing', nextPageNo: 1, executionNo: 1 });
    expect(await h.records()).toHaveLength(1);
  });
  it('临近过期的租约由页外续租延长，后续页断言有效', async () => {
    const h = await setup();
    afterPlan(h, () => h.port.advance(119));
    const active = h.port.assertExecutionActive.bind(h.port);
    vi.spyOn(h.port, 'assertExecutionActive').mockImplementation(async (tx, input) => {
      h.port.advance(2);
      return active(tx, input);
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed' });
  });
  it('锁内关键职位失效：R4 目标与全部 planned 提名永久失败', async () => {
    const h = await setup('overwrite', false, true);
    const before = await h.records();
    afterPlanCommit(h, async () => {
      const response = await w.call('PATCH', `job/positions/${h.target.id}`, {
        ifMatch: h.target.revision,
        body: { isKey: false, effectiveDate: SC_TODAY },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect(await h.records()).toEqual(before);
    expect(
      (await h.outcomes())
        .filter((r) => r.rowKind !== 'object')
        .every((r) => r.errorCode === 'TARGET_NOT_KEY_POSITION' && r.recovery === 'none'),
    ).toBe(true);
  });
  it.each(['uncommitted', 'committed', 'wrong_kind', 'wrong_execution'])(
    '执行页结果未知 %s：只认匹配执行的提交证明',
    async (mode) => {
      const committed = mode === 'committed';
      const h = await setup('overwrite_in_scope', true);
      const transaction = h.deps.transaction;
      const record = h.port.recordOutcome.bind(h.port);
      const commands: string[] = [];
      let page = false,
        fail = true;
      vi.spyOn(h.port, 'recordOutcome').mockImplementation(async (tx, input) => {
        page = true;
        commands.push(input.pageCommandId);
        return record(tx, input);
      });
      h.deps.transaction = async (work) => {
        page = false;
        const result = await transaction(async (tx) => {
          const value = await work(tx);
          if (page && fail && !committed) {
            fail = false;
            throw new Error('提交前中断');
          }
          return value;
        });
        if (page && fail) {
          fail = false;
          throw new Error('提交后回包丢失');
        }
        return result;
      };
      const proof = vi.spyOn(h.port, 'getPageCommit');
      if (mode.startsWith('wrong'))
        proof.mockResolvedValueOnce({
          ...h.key,
          rowCount: 0,
          kind: mode === 'wrong_kind' ? 'plan' : 'execute',
          executionNo: mode === 'wrong_execution' ? 99 : 1,
          pageNo: 1,
          pageCommandId: `${h.input.runId}:succession:1:1`,
          committedAt: SC_NOW,
        });
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed' });
      expect(proof).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          pageCommandId: `${h.input.runId}:succession:1:1`,
        }),
      );
      expect(new Set(commands).size).toBe(1);
      expect(commands).toHaveLength(committed ? 1 : 2);
      expect((await h.records())[0]).toMatchObject({ end_date: SC_TODAY, revision: 2 });
    },
  );
  it('目标保存点基础设施失败：业务与审计回滚，R9 / R10 可重试，不终结', async () => {
    const h = await setup('overwrite');
    const before = await h.records();
    const original = audit.recordAudit;
    const spy = vi.spyOn(audit, 'recordAudit').mockImplementation(async (tx, input) => {
      if (input.objectType === 'Succession.Record') throw new Error('审计存储失败');
      return original(tx, input);
    });
    try {
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'blocked' });
      expect(await h.records()).toEqual(before);
      const rows = await h.outcomes();
      expect(
        rows
          .filter((r) => r.rowKind === 'nomination')
          .every((r) => r.errorCode === 'STORAGE_UNAVAILABLE' && r.recovery === 'retry_same_run'),
      ).toBe(true);
      expect(rows.find((r) => r.rowId === FX.o1)).toMatchObject({
        errorCode: 'NOMINATIONS_FAILED',
        recovery: 'retry_same_run',
      });
    } finally {
      spy.mockRestore();
    }
  });
  it('终结本地提交失败：complete 与本地状态一起回滚，已提交执行页保留', async () => {
    const h = await setup();
    const complete = vi.spyOn(h.port, 'completeConsumption');
    const original = audit.recordAudit;
    let fail = true;
    const spy = vi.spyOn(audit, 'recordAudit').mockImplementation(async (tx, input) => {
      if (input.action === 'succession.sync-batch.complete' && fail) {
        fail = false;
        throw new Error('终结本地审计故障');
      }
      return original(tx, input);
    });
    try {
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'blocked', nextPageNo: 2 });
      const before = await h.records();
      expect(before).toHaveLength(3);
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed' });
      expect(await h.records()).toEqual(before);
      expect(complete).toHaveBeenCalledTimes(2);
      const rows = await w.asTenant((tx) =>
        tx.execute(sql`SELECT kind FROM succession_notifications
      WHERE tenant_id=${w.tenant.id}::uuid
      AND batch_id=${before.find((r) => r.source_batch_id)?.source_batch_id}::uuid`),
      );
      expect(rowsOf(rows)).toEqual([{ kind: 'sync_done' }]);
    } finally {
      spy.mockRestore();
    }
  });
  it('执行前源 run 已取代：本地清理屏障，不再次 abort 源端', async () => {
    const h = await setup();
    afterPlanCommit(h, async () => {
      await h.port.supersede(h.input.runId);
    });
    const abort = vi.spyOn(h.port, 'abortConsumption');
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'terminated', endReason: 'superseded' });
    expect(await h.records()).toHaveLength(1);
    expect(abort).not.toHaveBeenCalled();
    expect((await w.request('DELETE', `/records/${h.oldId}`, { ifMatch: 1 })).status).toBe(200);
  });
  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：201 个 delete_only 目标分两页续租且全部有终态证明',
    async () => {
      const h = await setup('overwrite_in_scope', true);
      const ids = [h.org.id];
      for (let i = 0; i < 200; i++) {
        const org = await w.org(`分页目标${i}`);
        ids.push(org.id);
        await w.insertRecord({ type: 'org', targetId: org.id, successorId: std.head.id });
      }
      const load = h.port.loadRun.bind(h.port);
      vi.spyOn(h.port, 'loadRun').mockImplementation(async (tx, input) => ({
        ...(await load(tx, input))!,
        scopeOrgIds: ids,
      }));
      const record = vi.spyOn(h.port, 'recordOutcome');
      const renew = vi.spyOn(h.port, 'renewLease');
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', nextPageNo: 3 });
      expect(record.mock.calls.map(([, input]) => input.items.filter((r) => r.rowKind === 'target').length)).toEqual([
        200, 1,
      ]);
      expect(renew).toHaveBeenCalledTimes(2);
      expect((await h.outcomes()).filter((r) => r.rowKind === 'target' && r.status === 'synced')).toHaveLength(201);
    },
    120_000,
  );
  it.each(['readiness', 'employee'])('计划后 %s 失效：锁内 R3 导致覆盖整组失败', async (kind) => {
    const h = await setup('overwrite');
    const before = await h.records();
    const employee = await w.hire(`离职反例${revision}`, {}, '2026-08-01');
    const ready = await w.readiness(`停用反例${revision}`);
    const list = h.port.listRunNominations.bind(h.port);
    vi.spyOn(h.port, 'listRunNominations').mockImplementation(async (tx, input) => {
      const page = await list(tx, input);
      return {
        ...page,
        items: page.items.map((n) =>
          n.nominationId === FX.n1 ? { ...n, successorEmployeeId: employee.id, readinessId: ready.id } : n,
        ),
      };
    });
    afterPlanCommit(h, async () => {
      if (kind === 'readiness')
        await w.asTenant((tx) =>
          tx.execute(sql`UPDATE talent_readiness_levels SET enabled=false
        WHERE tenant_id=${w.tenant.id}::uuid AND id=${ready.id}::uuid`),
        );
      else {
        const response = await w.call('POST', `employment/employees/${employee.id}/businesses`, {
          ifMatch: (await w.getEmployee(employee.id)).revision,
          body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30', fields: {} },
        });
        expect(response.status, await response.clone().text()).toBe(201);
        const state = await w.asTenant((tx) =>
          tx.execute(sql`
          SELECT t.start_date,t.valid_during::text,s.employee_status FROM employment_timeline t
          JOIN LATERAL employment_record_status(t.tenant_id,t.record_id) s ON true
          WHERE t.tenant_id=${w.tenant.id}::uuid AND t.employee_id=${employee.id}::uuid
          AND t.valid_during @> ${SC_TODAY}::date`),
        );
        expect(rowsOf(state)).toEqual([expect.objectContaining({ employee_status: 8 })]);
      }
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect(await h.records()).toEqual(before);
    expect((await h.outcomes()).find((r) => r.rowId === FX.n1)).toMatchObject({
      errorCode: kind === 'readiness' ? 'READINESS_DISABLED' : 'SUCCESSOR_NOT_ACTIVE',
      recovery: 'none',
    });
    expect((await h.outcomes()).find((r) => r.rowId === FX.n2)).toMatchObject({
      errorCode: 'TARGET_PARTIAL_NOMINATIONS',
    });
  });
  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：页等待目标锁期间撤写范围，锁内重验 R4，无业务变更',
    async () => {
      const h = await setup('overwrite');
      let covers = true;
      registerScopeProvider(h.deps.authorize, {
        authorize: async () => true,
        fields: async () => new Set(),
        scope: async () => ({
          ...EMPTY_SCOPE,
          terms: undefined,
          hasDataPermission: true,
          orgIds: covers ? [h.org.id, std.orgB.id] : [std.orgB.id],
        }),
      });
      const before = await h.records();
      // 持锁事务由被测流程在“计划提交后”的钩子里启动：门先建好（钩子晚于放行触发也不会挂住），
      // 钩子里开的持锁事务登记进 holders，由 withRelease 无条件放门并等它结束（F-282）
      let openGate!: () => void;
      const gate = new Promise<void>((r) => {
        openGate = r;
      });
      const holders: Promise<unknown>[] = [];
      afterPlanCommit(h, async () => {
        let locked!: () => void;
        const ready = new Promise<void>((r) => {
          locked = r;
        });
        holders.push(
          w.asTenant(async (tx) => {
            await tx.execute(sql`SELECT 1 FROM succession_target_locks WHERE tenant_id=${w.tenant.id}::uuid
          AND target_kind='org' AND target_id=${h.org.id}::uuid FOR UPDATE`);
            locked();
            await gate;
          }),
        );
        await ready;
      });
      const { running } = await withRelease(
        openGate,
        async (lock) => {
          const pending = lock.track(consumeRun(h.deps, h.input));
          await waitForBlocked(w.db, 1);
          covers = false;
          return { running: pending };
        },
        holders,
      );
      expect(await running).toMatchObject({ status: 'completed', result: 'partial' });
      expect(await h.records()).toEqual(before);
      expect((await h.outcomes()).find((r) => r.rowKind === 'target')).toMatchObject({
        errorCode: 'TARGET_OUT_OF_SCOPE',
        recovery: 'none',
      });
    },
  );
  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：A2 删除等待执行目标锁；页回滚后 D1 屏障仍返回 409',
    async () => {
      const h = await setup('overwrite');
      const before = await h.records();
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      vi.spyOn(h.port, 'recordOutcome').mockImplementation(async () => {
        entered();
        await gate;
        throw new SyncPortError('SOURCE_UNAVAILABLE', '页失败');
      });
      const running = consumeRun(h.deps, h.input);
      await ready;
      const deleting = w.request('DELETE', `/records/${h.oldId}`, { ifMatch: 1 });
      await withRelease(release, async (cleanup) => {
        [running, deleting].forEach(cleanup.track);
        await waitForBlocked(w.db, 1);
      });
      expect(await running).toMatchObject({ status: 'blocked' });
      const response = await deleting;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'TARGET_SYNC_IN_PROGRESS' } } });
      expect(await h.records()).toEqual(before);
    },
  );
});
