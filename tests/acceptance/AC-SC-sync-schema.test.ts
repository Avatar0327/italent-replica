/** D1 / 设计 §1.2：同步四表、RLS 与 A1/B3 延迟外键。 */
import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { successionWorld, type SuccessionWorld } from './AC-SC-support.js';
import { rowsOf } from './support/f048.js';

const testDb = useTestDb();
let w: SuccessionWorld;
let other: SuccessionWorld;
let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
const tables = ['succession_sync_batches', 'succession_sync_items', 'succession_sync_targets', 'succession_sync_mutex'];
beforeAll(async () => {
  w = await successionWorld(testDb().db, 'sc-sync-schema');
  other = await successionWorld(testDb().db, 'sc-sync-foreign');
  std = await w.standard();
});
const batch = async (world = w) => {
  const id = randomUUID();
  await world.asTenant((tx) =>
    tx.execute(sql`INSERT INTO succession_sync_batches
    (id,tenant_id,source_run_id,project_id,trigger,actor_user_id,source_principal_user_id,owner_user_id,business_date)
    VALUES (${id}::uuid,${world.tenant.id}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,
      'sync_requested',${world.user.id}::uuid,${world.user.id}::uuid,${world.user.id}::uuid,'2026-10-01')`),
  );
  return id;
};
const code = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    return pgErrorCode(error);
  }
  return undefined;
};

describe('AC-SC-sync-schema', () => {
  it('四张表全部开启并强制 RLS', async () => {
    const rows = rowsOf<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await testDb().db.execute(sql`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE relname = ANY(${`{${tables.join(',')}}`}::text[]) ORDER BY relname`),
    );
    expect(rows.map((row) => row.relname)).toEqual([...tables].sort());
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('批次按租户隔离，source_run_id 在租户内唯一', async () => {
    const id = await batch();
    const local = rowsOf<Record<string, unknown>>(
      await w.asTenant((tx) => tx.execute(sql`SELECT * FROM succession_sync_batches WHERE id=${id}::uuid`)),
    );
    expect(local[0]).toMatchObject({ status: 'waiting', has_plan: false, revision: 1 });
    const foreign = rowsOf(
      await withTenant(testDb().db, other.tenant.id, (tx) =>
        tx.execute(sql`SELECT * FROM succession_sync_batches WHERE id=${id}::uuid`),
      ),
    );
    expect(foreign).toEqual([]);
    expect(
      await code(() =>
        w.asTenant((tx) =>
          tx.execute(sql`INSERT INTO succession_sync_batches
      (tenant_id,source_run_id,project_id,trigger,actor_user_id,source_principal_user_id,owner_user_id,business_date)
      SELECT tenant_id,source_run_id,project_id,trigger,actor_user_id,
        source_principal_user_id,owner_user_id,business_date
      FROM succession_sync_batches WHERE id=${id}::uuid`),
        ),
      ),
    ).toBe('23505');
  });

  it('A1 source_batch_id：不存在或跨租户批次不可引用；被引用批次不可删，原记录保留', async () => {
    const id = await batch();
    const record = await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: std.successor1.id });
    expect(
      await code(() =>
        w.asTenant((tx) =>
          tx.execute(sql`UPDATE succession_records
      SET source_batch_id=${randomUUID()}::uuid WHERE id=${record}::uuid`),
        ),
      ),
    ).toBe('23503');
    const foreignBatch = await batch(other);
    expect(
      await code(() =>
        w.asTenant((tx) =>
          tx.execute(sql`UPDATE succession_records
      SET source_batch_id=${foreignBatch}::uuid WHERE id=${record}::uuid`),
        ),
      ),
    ).toBe('23503');
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_records SET source_batch_id=${id}::uuid
      WHERE id=${record}::uuid`),
    );
    expect(['23503', '23001']).toContain(
      await code(() => w.asTenant((tx) => tx.execute(sql`DELETE FROM succession_sync_batches WHERE id=${id}::uuid`))),
    );
    const rows = rowsOf<{ source_batch_id: string }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT source_batch_id FROM succession_records WHERE id=${record}::uuid`),
      ),
    );
    expect(rows[0]?.source_batch_id).toBe(id);
    expect(
      await code(() =>
        other.asTenant((tx) =>
          tx.execute(sql`INSERT INTO succession_sync_mutex
      (tenant_id,batch_id) VALUES (${other.tenant.id}::uuid,${id}::uuid)`),
        ),
      ),
    ).toBe('23503');
  });

  it('B3 batch_id：不存在批次不可引用；有通知的批次不可删，通知保留', async () => {
    const insert = (id: string) =>
      w.asTenant((tx) =>
        tx.execute(sql`INSERT INTO succession_notifications
      (tenant_id,batch_id,recipient_user_id,kind,command_id)
      VALUES (${w.tenant.id}::uuid,${id}::uuid,${w.user.id}::uuid,'sync_done',${randomUUID()})`),
      );
    expect(await code(() => insert(randomUUID()))).toBe('23503');
    const id = await batch();
    await insert(id);
    expect(['23503', '23001']).toContain(
      await code(() => w.asTenant((tx) => tx.execute(sql`DELETE FROM succession_sync_batches WHERE id=${id}::uuid`))),
    );
    const rows = rowsOf<{ batch_id: string }>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT batch_id FROM succession_notifications WHERE batch_id=${id}::uuid`),
      ),
    );
    expect(rows).toEqual([{ batch_id: id }]);
  });
});

// 子表必须同时受 RLS 与批次复合外键约束，不能仅靠调用方的 WHERE tenant_id。
it.each(['items', 'targets', 'mutex'] as const)('AC-SC-sync-schema %s 跨租户读写、引用与父删除', async (kind) => {
  const id = await batch();
  const table = sql.identifier(`succession_sync_${kind}`);
  const insert = (tenant: string, batchId: string) => {
    if (kind === 'mutex')
      return sql`INSERT INTO ${table} (tenant_id,batch_id)
      VALUES (${tenant}::uuid,${batchId}::uuid)`;
    if (kind === 'targets')
      return sql`INSERT INTO ${table}
      (tenant_id,batch_id,target_kind,target_id,action,target_row_key,execution_no,page_command_id)
      VALUES (${tenant}::uuid,${batchId}::uuid,'org',${std.orgA.id}::uuid,'append','org:test',1,'plan')`;
    return sql`INSERT INTO ${table}
      (tenant_id,batch_id,nomination_id,object_id,subject_employee_id,kind,direction,target_org_id,
       successor_employee_id,plan_outcome,execution_no,page_command_id)
      VALUES (${tenant}::uuid,${batchId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,
        ${std.successor1.id}::uuid,'org','successor',${std.orgA.id}::uuid,
        ${std.successor2.id}::uuid,'planned',1,'plan')`;
  };
  expect(await code(() => other.asTenant((tx) => tx.execute(insert(other.tenant.id, id))))).toBe('23503');
  expect(await code(() => other.asTenant((tx) => tx.execute(insert(w.tenant.id, id))))).toBe('42501');
  await w.asTenant((tx) => tx.execute(insert(w.tenant.id, id)));
  const before = rowsOf(await w.asTenant((tx) => tx.execute(sql`SELECT * FROM ${table} WHERE batch_id=${id}::uuid`)));
  expect(before).toHaveLength(1);
  expect(
    rowsOf(await other.asTenant((tx) => tx.execute(sql`SELECT * FROM ${table} WHERE batch_id=${id}::uuid`))),
  ).toEqual([]);
  expect(
    rowsOf(
      await other.asTenant((tx) =>
        tx.execute(sql`DELETE FROM ${table}
    WHERE batch_id=${id}::uuid RETURNING *`),
      ),
    ),
  ).toEqual([]);
  expect(['23503', '23001']).toContain(
    await code(() => w.asTenant((tx) => tx.execute(sql`DELETE FROM succession_sync_batches WHERE id=${id}::uuid`))),
  );
  expect(rowsOf(await w.asTenant((tx) => tx.execute(sql`SELECT * FROM ${table} WHERE batch_id=${id}::uuid`)))).toEqual(
    before,
  );
});
