/** D4 / §4.4：真实同步事务 + SP-18 替身。B5 合并前不复制其表或健康度实现。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle, type Tx } from '@italent/db';
import type { SyncOrgHealth } from '@italent/domain';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRun } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { syncFixture, FX } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { successionWorld, SC_NOW, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { syncTestTransaction } from './AC-SC-sync-support.js';

let handle: DbHandle;
let w: SuccessionWorld;
let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
const levelId = randomUUID();
const disabledId = randomUUID();
beforeAll(async () => {
  handle = await createTestDb();
  w = await successionWorld(handle.db, 'sc-health-sync');
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
    await tx.execute(sql`INSERT INTO succession_health_levels
      (tenant_id,id,code,name,color,display_order,enabled) VALUES
      (${w.tenant.id}::uuid,${levelId}::uuid,'D4_OK','健康','#46CF84',1,true),
      (${w.tenant.id}::uuid,${disabledId}::uuid,'D4_OFF','停用','#FF475A',2,false)`);
  });
}, 180_000);
afterAll(async () => {
  await handle?.close();
});

async function setup(status: SyncOrgHealth['status'] = 'value', manual = false, byCode = false) {
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL WHERE tenant_id=${w.tenant.id}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_batches SET status='terminated'
      WHERE tenant_id=${w.tenant.id}::uuid AND status NOT IN ('completed','terminated','rejected')`);
  });
  const org = await w.org(`健康度${randomUUID().slice(0, 8)}`);
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
        objects: [original.objects[0]!],
        nominations: [
          {
            ...original.nominations[0]!,
            orgId: std.orgA.id,
            successorEmployeeId: std.successor1.id,
            readinessId: null,
            readinessCode: null,
          },
        ],
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
        await tx.execute(sql`SELECT level_id,method,revision,source_batch_id,source_project_id
      FROM succession_health_results WHERE tenant_id=${w.tenant.id}::uuid AND org_id=${org.id}::uuid`),
      ),
    );
  return { org, health, deps, port, input, key, outcomes, local };
}
type Harness = Awaited<ReturnType<typeof setup>>;
function afterPlan(h: Harness, work: (tx: Tx) => Promise<void>) {
  const register = h.port.registerTargets.bind(h.port);
  vi.spyOn(h.port, 'registerTargets').mockImplementation(async (tx, input) => {
    const result = await register(tx, input);
    await work(tx);
    return result;
  });
}

describe('AC-SC-health-sync / AC-SC-07 D4', () => {
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
  });

  it('SP-19 #17：计划后健康度写范围收回，同页其他目标成功且提交证明有效', async () => {
    const h = await setup();
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
