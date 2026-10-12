/** D2：真实 SQL 业务写入 + SP-18 共同事务替身；旧实现停在计划，以下验收必须先红。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { consumeRun } from '../../apps/api/src/modules/succession/sync-consume.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { syncFixture, FX } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
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
  w = await successionWorld(testDb().db, 'sc-sync-execute');
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
async function setup(strategy = 'append', empty = false) {
  await w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL WHERE tenant_id=${w.tenant.id}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_batches SET status='terminated' WHERE tenant_id=${w.tenant.id}::uuid`);
  });
  await setting('sync_strategy', strategy, revision++);
  const org = await w.org(`执行目标${revision}`);
  const oldId = await w.insertRecord({ type: 'org', targetId: org.id, successorId: std.head.id });
  const fixture = syncFixture();
  const original = fixture.runs![0]!;
  const runId = randomUUID();
  const nominations = empty
    ? []
    : [0, 1].map((i) => ({
        ...original.nominations[0]!,
        nominationId: i ? FX.n2 : FX.n1,
        objectId: i ? FX.o2 : FX.o1,
        orgId: org.id,
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
    FROM succession_records WHERE tenant_id=${w.tenant.id}::uuid AND target_org_id=${org.id}::uuid ORDER BY id`),
      ),
    );
  const outcomes = async () => (await deps.transaction((tx) => port.getOutcomes(tx, key))).items;
  return { deps, port, input, key, org, oldId, records, outcomes };
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
    expect(await consumeRun(h.deps, h.input)).toMatchObject({ status: 'completed' });
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
});
