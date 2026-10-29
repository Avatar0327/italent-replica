/** D1 / SP-09～SP-11：数据库计划和 T04 替身必须共享提交、回滚边界。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { syncFixture, FX } from './support/sync-port-contract.js';
import { rowsOf } from './support/f048.js';
import { syncTestTransaction } from './AC-SC-sync-support.js';
import { withRelease } from './support/pg-interleave.js';

const testDb = useTestDb();
let member: Awaited<ReturnType<typeof seedTenantWithMember>>;
const stopped = new Error('模拟首次计划失败');
const setup = () => {
  const port = createInMemoryTalentReviewSyncPort({ ...syncFixture(), tenantId: member.tenant.id });
  const key = { tenantId: member.tenant.id, runId: FX.run, consumer: 'succession' as const };
  return { port, key, transaction: syncTestTransaction(testDb().db, member.tenant.id, port) };
};
beforeAll(async () => {
  member = await seedTenantWithMember(testDb().db, 'sc-sync-transaction');
  await testDb().db.execute(sql`CREATE TABLE sc_sync_tx_probe (tenant_id uuid NOT NULL, id uuid NOT NULL)`);
  await testDb().db.execute(sql`SELECT enable_tenant_isolation('sc_sync_tx_probe')`);
  await testDb().db.execute(sql`GRANT SELECT, INSERT ON sc_sync_tx_probe TO app_user`);
});

const localCount = async () =>
  rowsOf<{ count: number }>(
    await withTenant(testDb().db, member.tenant.id, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS count FROM sc_sync_tx_probe`),
    ),
  )[0]!.count;

describe('AC-SC-sync-transaction D1 首次计划的跨端口事务边界', () => {
  it('计划失败回滚后本地无计划、T04 无消费记录，重试仍是 executionNo=1', async () => {
    const { port, key, transaction } = setup();
    await expect(
      transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO sc_sync_tx_probe VALUES (${member.tenant.id}::uuid, ${FX.run}::uuid)`);
        await port.beginConsumption(tx, { ...key, leaseOwner: 'worker-1', leaseSeconds: 60 });
        throw stopped;
      }),
    ).rejects.toBe(stopped);
    expect(await localCount()).toBe(0);
    await expect(
      transaction((tx) => port.beginConsumption(tx, { ...key, leaseOwner: 'worker-2', leaseSeconds: 60 })),
    ).resolves.toMatchObject({ executionNo: 1, targetsSealed: false });
  });

  it('registerTargets 后数据库回滚：页 0 提交证明不得存在，预建回执仍全部 pending', async () => {
    const { port, key, transaction } = setup();
    const pageCommandId = `${FX.run}:succession:1:0`;
    await expect(
      transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO sc_sync_tx_probe VALUES (${member.tenant.id}::uuid, ${FX.run}::uuid)`);
        await port.beginConsumption(tx, { ...key, leaseOwner: 'worker-1', leaseSeconds: 60 });
        await port.registerTargets(tx, {
          ...key,
          executionNo: 1,
          planCommandId: pageCommandId,
          targets: [],
          planOutcomes: [
            {
              rowKind: 'nomination',
              rowId: FX.n3,
              status: 'skipped',
              recovery: 'none',
              errorParams: { reason: 'direction_target' },
              executionNo: 1,
              pageCommandId,
              updatedAt: new Date('2026-10-09T01:00:00Z'),
            },
          ],
        });
        throw stopped;
      }),
    ).rejects.toBe(stopped);
    expect(await localCount()).toBe(0);
    const proof = await transaction((tx) => port.getPageCommit(tx, { ...key, pageCommandId }));
    expect(proof).toBeNull();
    const rows = await transaction((tx) => port.getOutcomes(tx, key));
    expect(rows.items.every((row) => row.status === 'pending')).toBe(true);
  });

  it('C 类计划回滚后能 abortConsumption(null, ACTOR_SCOPE_EXCEEDED, new_run)', async () => {
    const { port, key, transaction } = setup();
    await expect(
      transaction(async (tx) => {
        await port.beginConsumption(tx, { ...key, leaseOwner: 'worker-1', leaseSeconds: 60 });
        throw stopped;
      }),
    ).rejects.toBe(stopped);
    await expect(
      transaction((tx) =>
        port.abortConsumption(tx, {
          ...key,
          executionNo: null,
          code: 'ACTOR_SCOPE_EXCEEDED',
          recovery: 'new_run',
        }),
      ),
    ).resolves.toMatchObject({ status: 'aborted', terminalRecovery: 'new_run' });
  });
});

it('AC-SC-sync-transaction 替身证明只在 SQL 事务成功后对其他事务可见', async () => {
  const { port, key, transaction } = setup();
  const pageCommandId = `${FX.run}:succession:1:0`;
  let planned!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    planned = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = transaction(async (tx) => {
    await port.beginConsumption(tx, { ...key, leaseOwner: 'worker-1', leaseSeconds: 60 });
    await port.registerTargets(tx, {
      ...key,
      executionNo: 1,
      planCommandId: pageCommandId,
      targets: [],
      planOutcomes: [],
    });
    planned();
    await gate;
  });
  await ready;
  await withRelease(release, async (cleanup) => {
    cleanup.track(work);
    expect(await port.transaction((tx) => port.getPageCommit(tx, { ...key, pageCommandId }))).toBeNull();
  });
  await work;
  expect(await port.transaction((tx) => port.getPageCommit(tx, { ...key, pageCommandId }))).toMatchObject({
    kind: 'plan',
    executionNo: 1,
    pageNo: 0,
  });
});
