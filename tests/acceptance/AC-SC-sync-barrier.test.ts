/** D1 / §7：计划在 A2 共用的目标锁内发布，四个手动写入口都受屏障保护。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertNoSyncBarrier } from '../../apps/api/src/modules/succession/sync-barrier.js';
import { successionWorld, type SuccessionWorld } from './AC-SC-support.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked, withRelease } from './support/pg-interleave.js';

const testDb = useTestDb();
let w: SuccessionWorld;
let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
let record: string;
const batch = randomUUID();
const target = randomUUID();
beforeAll(async () => {
  w = await successionWorld(testDb().db, 'sc-sync-barrier');
  std = await w.standard();
  record = await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: std.successor1.id });
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO succession_sync_batches
      (id,tenant_id,source_run_id,project_id,trigger,actor_user_id,source_principal_user_id,
       owner_user_id,business_date,status,has_plan)
      VALUES (${batch}::uuid,${w.tenant.id}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,
       'sync_requested',${w.user.id}::uuid,${w.user.id}::uuid,${w.user.id}::uuid,'2026-10-01','executing',true)`);
    await tx.execute(sql`INSERT INTO succession_sync_targets
      (id,tenant_id,batch_id,target_kind,target_id,action,target_row_key,execution_no,page_command_id)
      VALUES (${target}::uuid,${w.tenant.id}::uuid,${batch}::uuid,'org',${std.orgA.id}::uuid,
       'overwrite',${`org:${std.orgA.id}`},1,${`${batch}:succession:1:0`})`);
  });
});
const check = () => w.asTenant((tx) => assertNoSyncBarrier(tx, w.tenant.id, [{ kind: 'org', id: std.orgA.id }]));
const update = () => w.request('PUT', `/records/${record}`, { ifMatch: 1, body: { backupType: 'deputy' } });
const state = async (status: string, targetStatus: string, retryable: boolean) =>
  w.asTenant(async (tx) => {
    await tx.execute(sql`UPDATE succession_sync_batches SET status=${status} WHERE id=${batch}::uuid`);
    await tx.execute(sql`UPDATE succession_sync_targets SET status=${targetStatus},retryable=${retryable}
    WHERE id=${target}::uuid`);
  });
const stored = async () =>
  rowsOf(
    await w.asTenant((tx) =>
      tx.execute(
        sql`SELECT revision,backup_type,end_date::text,deleted_at FROM succession_records WHERE id=${record}::uuid`,
      ),
    ),
  );

describe('AC-SC-sync-barrier', () => {
  it('新增、编辑、结束、删除全部 409 TARGET_SYNC_IN_PROGRESS，业务记录保持原样', async () => {
    const before = await stored();
    const requests = [
      () =>
        w.request('POST', '/records', {
          body: {
            successionType: 'org',
            targetOrgId: std.orgA.id,
            successorEmployeeId: std.successor2.id,
            startDate: '2026-09-01',
          },
        }),
      update,
      () =>
        w.request('POST', '/records/end', {
          body: { items: [{ id: record, expectedRevision: 1 }], endDate: '2026-09-30' },
        }),
      () => w.request('DELETE', `/records/${record}`, { ifMatch: 1 }),
    ];
    for (const request of requests) {
      const response = await request();
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'TARGET_SYNC_IN_PROGRESS' } } });
      expect(await stored()).toEqual(before);
    }
  });

  it.each([
    ['executing', 'pending', false, true],
    ['blocked', 'pending', false, true],
    ['blocked', 'failed', true, true],
    ['blocked', 'failed', false, false],
    ['executing', 'done', false, false],
    ['completed', 'pending', false, false],
    ['terminated', 'aborted', false, false],
    ['waiting', 'pending', false, false],
  ] as const)('屏障状态 %s / %s / retryable=%s → %s', async (batchStatus, targetStatus, retryable, blocked) => {
    await state(batchStatus, targetStatus, retryable);
    if (blocked) await expect(check()).rejects.toMatchObject({ details: { reason: 'TARGET_SYNC_IN_PROGRESS' } });
    else await expect(check()).resolves.toBeUndefined();
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))('真 PG：计划先持目标锁，A2 等待提交后读到屏障', async () => {
    await state('waiting', 'done', false);
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const planning = w.asTenant(async (tx) => {
      await tx.execute(sql`INSERT INTO succession_target_locks (tenant_id,target_kind,target_id)
        VALUES (${w.tenant.id}::uuid,'org',${std.orgA.id}::uuid) ON CONFLICT DO NOTHING`);
      await tx.execute(sql`SELECT 1 FROM succession_target_locks WHERE tenant_id=${w.tenant.id}::uuid
        AND target_kind='org' AND target_id=${std.orgA.id}::uuid FOR UPDATE`);
      locked();
      await gate;
      await tx.execute(sql`UPDATE succession_sync_batches SET status='executing' WHERE id=${batch}::uuid`);
      await tx.execute(sql`UPDATE succession_sync_targets SET status='pending' WHERE id=${target}::uuid`);
    });
    await acquired;
    const writing = update();
    await withRelease(release, async (cleanup) => {
      [planning, writing].forEach(cleanup.track);
      await waitForBlocked(w.db, 1);
    });
    await planning;
    const response = await writing;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'TARGET_SYNC_IN_PROGRESS' } } });
  });
});
