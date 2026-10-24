/** D4 / §4.4：真实同步事务 + SP-18 替身。B5 健康度使用真实迁移、结果表和 worker。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle, type Tx } from '@italent/db';
import type { SyncOrgHealth } from '@italent/domain';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRun, planSyncRun } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { syncFixture, FX } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { syncTestTransaction } from './AC-SC-sync-support.js';
import { levelBody } from './AC-SC-levels-support.js';
import { settledOrBlocked, withRelease } from './support/pg-interleave.js';
import { enableHealthRunner } from './AC-SC-07-health-support.js';
import { waitHealthLock } from './AC-SC-07-health-lock-support.js';
import { enqueueCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { uniqueSuffix } from './support/unique.js';

let handle: DbHandle;
let w: SuccessionWorld;
let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
const levelId = randomUUID();
const disabledId = randomUUID();
beforeAll(async () => {
  handle = await createTestDb();
  w = await successionWorld(handle.db, 'sc-health-sync');
  std = await w.standard();
  await enableHealthRunner(w);
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO succession_health_levels
      (tenant_id,id,code,name,color,display_order,enabled) VALUES
      (${w.tenant.id}::uuid,${levelId}::uuid,'D4_OK','健康','#46CF84',1,true),
      (${w.tenant.id}::uuid,${disabledId}::uuid,'D4_OFF','停用','#FF475A',2,false)`);
  });
}, 180_000);
afterAll(async () => {
  await handle?.close();
});

async function setup(
  status: SyncOrgHealth['status'] = 'value',
  manual = false,
  byCode = false,
  extra: Partial<SyncOrgHealth> = {},
  nomination = true,
) {
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL WHERE tenant_id=${w.tenant.id}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_batches SET status='terminated'
      WHERE tenant_id=${w.tenant.id}::uuid AND status NOT IN ('completed','terminated','rejected')`);
  });
  const org = await w.org(`健康度${uniqueSuffix()}`);
  const source = syncFixture(),
    original = source.runs![0]!,
    runId = randomUUID();
  const health: SyncOrgHealth = {
    ...original.orgHealth[0]!,
    orgId: org.id,
    status,
    manual,
    levelId: status === 'value' && !byCode ? levelId : null,
    levelCode: status === 'value' ? 'D4_OK' : null,
    ...extra,
  };
  const fixture = {
    ...source,
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
        },
        objects: nomination ? [original.objects[0]!] : [],
        nominations: nomination
          ? [
              {
                ...original.nominations[0]!,
                orgId: std.orgA.id,
                successorEmployeeId: std.successor1.id,
                readinessId: null,
                readinessCode: null,
              },
            ]
          : [],
        orgHealth: [health],
      },
    ],
  };
  const port = createInMemoryTalentReviewSyncPort(fixture);
  const deps = {
    db: w.db,
    port,
    clock: () => SC_NOW,
    authorize: () => true,
    transaction: syncTestTransaction(w.db, w.tenant.id, port),
  };
  const input = { tenantId: w.tenant.id, runId, leaseOwner: randomUUID() };
  const key = { tenantId: w.tenant.id, runId, consumer: 'succession' as const };
  const outcomes = async () => (await deps.transaction((tx) => port.getOutcomes(tx, key))).items;
  const local = () =>
    w.asTenant(async (tx) =>
      rowsOf<Record<string, unknown>>(
        await tx.execute(sql`SELECT level_id,method,revision,source_batch_id,source_project_id,source_meeting_id
      FROM succession_health_results WHERE tenant_id=${w.tenant.id}::uuid AND org_id=${org.id}::uuid`),
      ),
    );
  return { org, health, deps, port, input, key, outcomes, local };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function seedResult(h: Harness, method = 'manual') {
  await w.asTenant((tx) =>
    tx.execute(sql`INSERT INTO succession_health_results
    (tenant_id,org_id,level_id,method,revision) VALUES
    (${w.tenant.id}::uuid,${h.org.id}::uuid,${levelId}::uuid,${method},7)`),
  );
  return h.local();
}
function afterPlan(h: Harness, work: (tx: Tx) => Promise<void>) {
  const register = h.port.registerTargets.bind(h.port);
  vi.spyOn(h.port, 'registerTargets').mockImplementation(async (tx, input) => {
    const result = await register(tx, input);
    await work(tx);
    return result;
  });
}

describe('AC-SC-health-sync / AC-SC-07 D4', () => {
  async function mappedLevel() {
    const created = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        ...levelBody('health'),
        rules: {
          expression: '1',
          rows: [
            {
              rowNo: 1,
              population: 'all',
              fieldSource: 'org',
              fieldCode: 'on_duty_count',
              measure: 'average',
              comparator: 'ge',
              threshold: 0,
            },
          ],
        },
      },
    });
    expect(created.status).toBe(201);
    return (await created.json()) as { id: string; revision: number; code: string };
  }
  it('计划提交后真实 HTTP 删除等级返回 LEVEL_IN_USE，原批次仍能完成', async () => {
    const level = await mappedLevel();
    const h = await setup('value', false, false, { levelId: level.id, levelCode: level.code });
    expect(await planSyncRun(h.deps, h.input)).toMatchObject({ status: 'executing' });
    const deletion = await w.request('DELETE', `/health-levels/${level.id}`, { ifMatch: level.revision });
    expect(deletion.status, await deletion.clone().text()).toBe(409);
    expect(await deletion.json()).toMatchObject({ error: { details: { reason: 'LEVEL_IN_USE' } } });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'succeeded' });
    expect(await h.local()).toEqual([expect.objectContaining({ level_id: level.id, method: 'synced' })]);
  });
  it.each(['value', 'empty'] as const)(
    'Q-SC-16：真实 HTTP 赋值后同步 %s 与 B5 后续计算都保持旧手工值',
    async (status) => {
      const h = await setup(status, false, false, {}, false);
      const assigned = await w.request('PUT', `/health-results/${h.org.id}`, { ifMatch: 0, body: { levelId } });
      expect(assigned.status, await assigned.clone().text()).toBe(200);
      const before = await h.local();
      const batch = await consumeRun(h.deps, h.input);
      expect(batch).toMatchObject({ status: 'completed', result: 'succeeded' });
      const [run] = await w.asTenant(async (tx) =>
        rowsOf<{ id: string }>(
          await tx.execute(sql`
      SELECT id FROM succession_calc_runs WHERE idempotency_key=${`org_health:sync:${batch!.id}`}`),
        ),
      );
      expect(await runCalcPage(w.db, w.tenant.id, run!.id, undefined, SC_NOW)).toBe('succeeded');
      expect(await h.local()).toEqual(before);
      expect((await h.outcomes()).find((r) => r.rowKind === 'org_health')).toMatchObject({
        status: 'synced',
        errorParams: { manualKept: true },
      });
    },
  );
  it('同步计算冻结 org 与 org_health 的并集，真实 B5 worker 只处理该集合', async () => {
    const h = await setup('value', true);
    const batch = await consumeRun(h.deps, h.input);
    const [run] = await w.asTenant(async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`
      SELECT id FROM succession_calc_runs WHERE idempotency_key=${`org_health:sync:${batch!.id}`}`),
      ),
    );
    const before = await h.local();
    expect(await runCalcPage(w.db, w.tenant.id, run!.id, undefined, SC_NOW)).toBe('succeeded');
    expect(await h.local()).toEqual(before);
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT object_id,outcome FROM succession_calc_run_objects WHERE run_id=${run!.id}::uuid ORDER BY object_id`),
        ),
      ),
    ).toEqual(
      [
        { object_id: h.org.id, outcome: 'manual_kept' },
        { object_id: std.orgA.id, outcome: 'written' },
      ].sort((a, b) => a.object_id.localeCompare(b.object_id)),
    );
  });
  it.runIf(Boolean(process.env.TEST_DATABASE_URL)).each(['assign', 'org_health', 'org_health_reset'] as const)(
    '真 PG：D4 执行持锁时 B5 %s 等待，随后 CAS 冲突或手工值保护',
    async (action) => {
      const h = await setup('value', true, false, {}, false);
      const workerId =
        action === 'assign'
          ? null
          : await w.asTenant((tx) =>
              enqueueCalcRun(
                tx,
                {
                  tenantId: w.tenant.id,
                  kind: action,
                  trigger: 'manual',
                  commandId: randomUUID(),
                  requestedBy: w.user.id,
                  businessDate: SC_TODAY,
                  objects: [{ objectType: 'org', objectId: h.org.id, expectedRevision: 0 }],
                },
                SC_NOW,
              ),
            );
      await planSyncRun(h.deps, h.input);
      let entered!: (pid: number) => void, release!: () => void;
      const ready = new Promise<number>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const record = h.port.recordOutcome.bind(h.port);
      vi.spyOn(h.port, 'recordOutcome').mockImplementationOnce(async (tx, input) => {
        const result = await record(tx, input);
        const [backend] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
        entered(backend!.pid);
        await gate;
        return result;
      });
      const consuming = consumeRun(h.deps, h.input);
      const pid = await Promise.race([
        ready,
        consuming.then((r) => {
          throw new Error(`同步提前结束 ${r?.status}`);
        }),
      ]);
      const operation =
        action === 'assign'
          ? w.request('PUT', `/health-results/${h.org.id}`, { ifMatch: 0, body: { levelId } })
          : runCalcPage(w.db, w.tenant.id, workerId!, undefined, SC_NOW);
      await withRelease(release, async (cleanup) => {
        [consuming, operation].forEach(cleanup.track);
        expect((await waitHealthLock(w.db, pid, 'org_settings')).query).toContain('org_settings');
      });
      expect(await consuming).toMatchObject({ status: 'completed', result: 'succeeded' });
      const result = await operation;
      if (typeof result !== 'string') {
        expect(result.status).toBe(409);
        expect(await result.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
      } else {
        expect(result).toBe(action === 'org_health' ? 'succeeded' : 'partial');
        expect(
          await w.asTenant(async (tx) =>
            rowsOf(
              await tx.execute(sql`
          SELECT outcome FROM succession_calc_run_objects WHERE run_id=${workerId}::uuid`),
            ),
          ),
        ).toEqual([{ outcome: action === 'org_health' ? 'manual_kept' : 'revision_conflict' }]);
      }
      expect(await h.local()).toEqual([expect.objectContaining({ level_id: levelId, method: 'manual', revision: 1 })]);
    },
  );
  it.each(['blocked', 'terminated'] as const)('计划 %s 后等级删除只保护可恢复目标', async (status) => {
    const level = await mappedLevel();
    const h = await setup('value', false, false, { levelId: level.id, levelCode: level.code });
    const batch = await planSyncRun(h.deps, h.input);
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_sync_batches SET status=${status}
      WHERE tenant_id=${w.tenant.id}::uuid AND id=${batch!.id}::uuid`),
    );
    const deletion = await w.request('DELETE', `/health-levels/${level.id}`, { ifMatch: level.revision });
    expect(deletion.status, await deletion.clone().text()).toBe(status === 'blocked' ? 409 : 200);
  });
  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：映射未提交时 HTTP 删除等待同一规则锁，提交后拒删',
    async () => {
      const level = await mappedLevel();
      const h = await setup('value', false, false, { levelId: level.id, levelCode: level.code });
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const register = h.port.registerTargets.bind(h.port);
      vi.spyOn(h.port, 'registerTargets').mockImplementationOnce(async (tx, input) => {
        const result = await register(tx, input);
        entered();
        await gate;
        return result;
      });
      const planning = planSyncRun(h.deps, h.input);
      await reached;
      const deletion = w.request('DELETE', `/health-levels/${level.id}`, { ifMatch: level.revision });
      const observed = await withRelease(release, async (cleanup) => {
        [planning, deletion].forEach(cleanup.track);
        return await settledOrBlocked(w.db, deletion, 1);
      });
      await planning;
      const response = await deletion;
      expect(observed).toBe('blocked');
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'succeeded' });
    },
  );
  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：删除先取得规则锁，后来的计划只在计划期报等级未知',
    async () => {
      const level = await mappedLevel();
      const h = await setup('value', false, false, { levelId: level.id, levelCode: level.code });
      let ready!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = w.asTenant(async (tx) => {
        await tx.execute(sql`SELECT kind FROM succession_rule_settings
        WHERE tenant_id=${w.tenant.id}::uuid AND kind='org_health' FOR UPDATE`);
        ready();
        await gate;
      });
      await entered;
      const deletion = w.request('DELETE', `/health-levels/${level.id}`, { ifMatch: level.revision });
      let planning: ReturnType<typeof planSyncRun> | undefined;
      await withRelease(
        release,
        async (cleanup) => {
          [deletion, blocker].forEach(cleanup.track);
          expect(await settledOrBlocked(w.db, deletion, 1)).toBe('blocked');
          planning = cleanup.track(planSyncRun(h.deps, h.input));
          expect(await settledOrBlocked(w.db, planning, 2)).toBe('blocked');
        },
        [blocker],
      );
      expect((await deletion).status).toBe(200);
      expect(await planning).toMatchObject({ status: 'executing' });
      expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
      expect((await h.outcomes()).find((r) => r.rowKind === 'org_health')).toMatchObject({
        errorCode: 'HEALTH_LEVEL_UNKNOWN',
        pageCommandId: `${h.input.runId}:succession:1:0`,
        recovery: 'none',
      });
      expect(await h.local()).toEqual([]);
    },
  );
  it.each(['module_absent', 'present'] as const)('嵌套继任 %s + 0 不阻断健康度及其后续 run', async (status) => {
    const h = await setup(
      'value',
      false,
      false,
      {
        meetingId: FX.meeting,
        succession: { status, count: 0, nominations: [] },
      },
      false,
    );
    const batch = await consumeRun(h.deps, h.input);
    expect(batch).toMatchObject({ status: 'completed', result: 'succeeded' });
    expect(await h.local()).toEqual([expect.objectContaining({ source_meeting_id: FX.meeting, level_id: levelId })]);
    const runs = await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT object_id FROM succession_calc_run_objects o JOIN succession_calc_runs r
      ON r.tenant_id=o.tenant_id AND r.id=o.run_id WHERE r.tenant_id=${w.tenant.id}::uuid
      AND r.idempotency_key=${`org_health:sync:${batch!.id}`}`),
      ),
    );
    expect(runs).toEqual([{ object_id: h.org.id }]);
  });
  it('没有执行页的永久失败批次仍按同一幂等键入队一次', async () => {
    const h = await setup('value', false, false, { levelId: randomUUID() }, false);
    const batch = await consumeRun(h.deps, h.input);
    expect(batch).toMatchObject({ status: 'completed', result: 'partial', nextPageNo: 1 });
    await consumeRun(h.deps, h.input);
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT count(*)::int AS n FROM succession_calc_runs WHERE tenant_id=${w.tenant.id}::uuid
      AND idempotency_key=${`org_health:sync:${batch!.id}`}`),
        ),
      ),
    ).toEqual([{ n: 1 }]);
  });
  it.each(['value', 'empty'] as const)('Q-SC-16：本地 manual 遇 %s 同步保持等级、标记和 revision', async (status) => {
    const h = await setup(status),
      before = await seedResult(h);
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'succeeded' });
    expect(await h.local()).toEqual(before);
    expect((await h.outcomes()).find((r) => r.rowKind === 'org_health')).toMatchObject({
      status: 'synced',
      errorParams: { manualKept: true },
      recovery: 'none',
    });
  });
  it.each([
    ['未知 ID', { levelId: randomUUID() }, 'HEALTH_LEVEL_UNKNOWN'],
    ['未知 code', { levelId: null, levelCode: 'MISSING' }, 'HEALTH_LEVEL_UNKNOWN'],
    ['停用 ID', { levelId: disabledId }, 'HEALTH_LEVEL_DISABLED'],
    ['停用 code', { levelId: null, levelCode: 'D4_OFF' }, 'HEALTH_LEVEL_DISABLED'],
  ] as const)('%s：计划永久失败并保持旧值，同页合法提名仍成功', async (_name, extra, code) => {
    const h = await setup('value', false, false, extra),
      before = await seedResult(h, 'computed');
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect(await h.local()).toEqual(before);
    expect((await h.outcomes()).find((r) => r.rowKind === 'org_health')).toMatchObject({
      status: 'failed',
      errorCode: code,
      recovery: 'none',
      pageCommandId: `${h.input.runId}:succession:1:0`,
    });
    expect((await h.outcomes()).find((r) => r.rowKind === 'nomination')).toMatchObject({ status: 'synced' });
  });
  it('not_provided 不改旧值、不建健康度目标', async () => {
    const h = await setup('not_provided'),
      before = await seedResult(h, 'computed');
    const batch = await consumeRun(h.deps, h.input);
    expect(batch).toMatchObject({ status: 'completed' });
    expect(await h.local()).toEqual(before);
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`SELECT id FROM succession_sync_targets
      WHERE tenant_id=${w.tenant.id}::uuid AND batch_id=${batch!.id}::uuid AND target_kind='org_health'`),
        ),
      ),
    ).toEqual([]);
  });
  it('回执失败回滚健康度及审计，页内重做只产生 revision 1', async () => {
    const h = await setup(),
      record = h.port.recordOutcome.bind(h.port);
    let attempts = 0;
    vi.spyOn(h.port, 'recordOutcome').mockImplementation(async (tx, input) => {
      const result = await record(tx, input);
      if (!attempts++) throw new Error('模拟回执后事务回滚');
      return result;
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed' });
    expect(await h.local()).toEqual([expect.objectContaining({ revision: 1, method: 'synced' })]);
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
      WHERE tenant_id=${w.tenant.id}::uuid AND object_id=${h.org.id}
      AND action='succession.health-result.sync'`),
        ),
      ),
    ).toEqual([{ n: 1 }]);
  });
  it.each([
    ['value', false, false, 'synced'],
    ['value', true, false, 'manual'],
    ['value', false, true, 'synced'],
    ['empty', false, false, 'synced'],
    ['empty', true, false, 'manual'],
  ] as const)('%s manual=%s 按等级 ID / code 映射写入，来源与回执同页提交', async (status, manual, byCode, method) => {
    const h = await setup(status, manual, byCode);
    const batch = await consumeRun(h.deps, h.input);
    expect(batch).toMatchObject({ status: 'completed', result: 'succeeded' });
    if (!batch) throw new Error('同步必须返回批次');
    expect(await h.local()).toEqual([
      expect.objectContaining({
        level_id: status === 'value' ? levelId : null,
        method,
        revision: 1,
        source_batch_id: batch.id,
        source_project_id: FX.project,
      }),
    ]);
    expect(await h.outcomes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowKind: 'org_health', rowId: h.org.id, status: 'synced', recovery: 'none' }),
      ]),
    );
    const runs = await w.asTenant(async (tx) =>
      rowsOf<{ id: string; idempotency_key: string }>(
        await tx.execute(sql`SELECT id,idempotency_key FROM succession_calc_runs
        WHERE tenant_id=${w.tenant.id}::uuid AND idempotency_key=${`org_health:sync:${batch.id}`}`),
      ),
    );
    expect(runs).toHaveLength(1);
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT object_id FROM succession_calc_run_objects WHERE tenant_id=${w.tenant.id}::uuid
      AND run_id=${runs[0]!.id}::uuid AND object_id=${h.org.id}::uuid`),
        ),
      ),
    ).toEqual([{ object_id: h.org.id }]);
    const before = await h.local();
    await consumeRun(h.deps, h.input);
    expect(await h.local()).toEqual(before);
  });

  it.each(['not_provided', 'forbidden'] as const)('%s 在计划阶段终态，不把其他合法目标一起阻塞', async (status) => {
    const h = await setup(status);
    const batch = await consumeRun(h.deps, h.input);
    expect(batch).toMatchObject({ status: 'completed', result: status === 'forbidden' ? 'partial' : 'succeeded' });
    const rows = await h.outcomes();
    expect(rows.find((r) => r.rowKind === 'org_health')).toMatchObject(
      status === 'forbidden'
        ? {
            status: 'failed',
            errorCode: 'SOURCE_REVOKED',
            errorParams: { scope: 'org', ref: h.org.id },
            recovery: 'none',
          }
        : { status: 'skipped', errorParams: { reason: 'not_provided' } },
    );
    expect(rows.find((r) => r.rowKind === 'nomination')).toMatchObject({ status: 'synced' });
  });

  it.each(['org', 'field'] as const)('执行期源%s撤权只失败健康度行，字段授权包含 levelId', async (scope) => {
    const h = await setup();
    const before = await seedResult(h, 'computed');
    afterPlan(h, async () => {
      await h.port.revoke(scope === 'org' ? { orgIds: [h.org.id] } : { fieldCodes: ['levelId'] });
    });
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed', result: 'partial' });
    expect((await h.outcomes()).find((r) => r.rowKind === 'org_health')).toMatchObject({
      status: 'failed',
      errorCode: 'SOURCE_REVOKED',
      recovery: 'none',
      errorParams: { scope, ref: scope === 'org' ? h.org.id : 'levelId' },
    });
    expect(await h.local()).toEqual(before);
    expect((await h.outcomes()).find((r) => r.rowKind === 'nomination')).toMatchObject({ status: 'synced' });
  });

  it('SP-19 #17：计划后健康度写范围收回，同页其他目标成功且提交证明有效', async () => {
    const h = await setup();
    const before = await seedResult(h);
    afterPlan(h, async () => {
      registerScopeProvider(h.deps.authorize, {
        authorize: async () => true,
        fields: async () => new Set(),
        scope: async (request) =>
          request.objectCode === 'Succession.HealthResult'
            ? { ...EMPTY_SCOPE, terms: undefined, hasDataPermission: true, orgIds: [std.orgA.id] }
            : { ...EMPTY_SCOPE, hasDataPermission: true, all: true },
      });
    });
    const batch = await consumeRun(h.deps, h.input);
    expect(batch).toMatchObject({ status: 'completed', result: 'partial' });
    const rows = await h.outcomes();
    expect(rows.find((r) => r.rowKind === 'org_health')).toMatchObject({
      status: 'failed',
      errorCode: 'TARGET_OUT_OF_SCOPE',
      recovery: 'none',
    });
    expect(rows.find((r) => r.rowKind === 'nomination')).toMatchObject({ status: 'synced' });
    expect(await h.local()).toEqual(before);
    expect(
      await h.deps.transaction((tx) =>
        h.port.getPageCommit(tx, {
          ...h.key,
          pageCommandId: `${h.input.runId}:succession:1:1`,
        }),
      ),
    ).toMatchObject({ kind: 'execute', executionNo: 1 });
  });
});
