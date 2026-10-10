/**
 * AC-QL-sync（R3-T02 C1-4，设计 §4.3 / §7.4；F-055 拆分方案 §10）：资格同步队列与处理器。
 * - 入队触发器：employment_outbox 上 record.create 事件在同一事务内各入一行 ev_sync_queue（qualification_sync），
 *   判重键 UNIQUE(tenant_id, handler, dedupe_key)，重复入队只一行；其他事件不入队；
 * - 消费：状态队列 + F-055 recordEventReadySql 取数，没有时间游标——未来生效的记录到期前不生成、到期后生成；
 *   先保存未来记录、再删除、再跑真实取数循环 → 该行被取到、复核 gone、skipped: RECORD_NOT_EFFECTIVE，不留 pending；
 * - 失败记次数 / 原因并退避，到点自动重试（DEC-052）；按租户时区（DEC-056）；租户隔离。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  qualificationSyncProbe,
  qualificationSyncSchedulerEnabled,
} from '../../apps/api/src/modules/qualification/sync-worker.js';
import { HANDLER, rowsOf, syncWorld } from './AC-QL-sync-support.js';

const database = useTestDb();

async function configured(label: string, options: { timezone?: string } = {}) {
  const w = await syncWorld(database().db, label, options);
  const sequenceId = await w.sequence('同步序列');
  const jobLevelId = await w.jobLevel();
  const categoryId = await w.category({ type: 'sequence', jobObjectId: sequenceId });
  const levelId = await w.level({ type: 'level', jobObjectId: jobLevelId });
  await w.settleBaseline();
  await w.enableSync(true);
  return { w, fields: { sequenceId, levelId: jobLevelId }, categoryId, levelId };
}

describe('AC-QL-sync 入队触发器（设计 §4.3）', () => {
  it('每个 record.create 事件入一行 pending（qualification_sync），判重键 = outbox 事件 ID；其他事件不入队（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-trigger');
    const recordId = await w.transferWith('2026-10-20', fields);
    const rows = await w.queue(recordId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'pending', attempts: 0, recordId, employeeId: w.subject.employee.id });
    const [event] = await w.events(recordId);
    expect(rows[0]!.dedupeKey).toBe(event!.id);

    const counts = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ events: number; queued: number; others: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${w.tenantId} AND event_type='employment.record.create') AS events,
          (SELECT count(*)::int FROM ev_sync_queue WHERE tenant_id=${w.tenantId} AND handler=${HANDLER}) AS queued,
          (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${w.tenantId} AND event_type<>'employment.record.create') AS others`),
      ),
    );
    expect(counts[0]!.others).toBeGreaterThan(0);
    expect(counts[0]!.queued).toBe(counts[0]!.events);
  });

  it('重复入队只一行：同一事件再次入队 ON CONFLICT DO NOTHING；裸插入同判重键被唯一约束拒绝（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-dedupe');
    const recordId = await w.transferWith('2026-10-20', fields);
    const before = await w.queue(recordId);
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO ev_sync_queue (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id)
        SELECT tenant_id, ${HANDLER}, id::text, id, employee_id, object_id FROM employment_outbox
        WHERE tenant_id=${w.tenantId} AND object_id=${recordId}::uuid AND event_type='employment.record.create'
        ON CONFLICT DO NOTHING`),
    );
    expect(await w.queue(recordId)).toEqual(before);
    await expect(
      withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`INSERT INTO ev_sync_queue (tenant_id, handler, dedupe_key, employee_id, record_id)
          VALUES (${w.tenantId}, ${HANDLER}, ${before[0]!.dedupeKey}, ${before[0]!.employeeId}::uuid, ${recordId}::uuid)`),
      ),
    ).rejects.toThrow();
  });
});

describe('AC-QL-sync 生效日与删除（F-055，设计 §4.3）', () => {
  it('未来生效的记录：到期前不生成、仍 pending；到期当天生成（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-future');
    const recordId = await w.transferWith('2026-10-20', fields);
    expect(await w.run('2026-10-10T05:00:00Z')).toMatchObject({ done: 0, skipped: 0, failed: 0 });
    expect(await w.run('2026-10-19T05:00:00Z')).toMatchObject({ done: 0, skipped: 0, failed: 0 });
    expect(await w.queue(recordId)).toMatchObject([{ state: 'pending', attempts: 0 }]);
    expect(await w.subsets()).toEqual([]);

    expect(await w.run('2026-10-20T05:00:00Z')).toMatchObject({ done: 1 });
    expect(await w.queue(recordId)).toMatchObject([{ state: 'done', attempts: 1 }]);
    expect(await w.subsets()).toMatchObject([{ startDate: '2026-10-20', employmentRecordId: recordId }]);
  });

  it('先保存未来记录、再删除、再跑真实取数循环：取到、复核 gone、skipped: RECORD_NOT_EFFECTIVE，不留 pending（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-delete');
    const recordId = await w.transferWith('2026-10-20', fields);
    await w.remove(recordId);
    const result = await w.run('2026-10-10T05:00:00Z');
    expect(result).toMatchObject({ skipped: 1, done: 0 });
    expect(await w.queue(recordId)).toMatchObject([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await w.queue()).not.toContainEqual(expect.objectContaining({ state: 'pending' }));
    expect(await w.subsets()).toEqual([]);
  });

  it('改期（删除后以新日期重存）：旧行 skipped，新行按新日期到期后生成（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-reschedule');
    const oldId = await w.transferWith('2026-10-20', fields);
    await w.remove(oldId);
    const newId = await w.transferWith('2026-10-25', fields);
    await w.run('2026-10-21T05:00:00Z');
    expect(await w.queue(oldId)).toMatchObject([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await w.queue(newId)).toMatchObject([{ state: 'pending' }]);
    await w.run('2026-10-25T05:00:00Z');
    expect(await w.queue(newId)).toMatchObject([{ state: 'done' }]);
    expect(await w.subsets()).toMatchObject([{ startDate: '2026-10-25', employmentRecordId: newId }]);
  });

  it('生效日按租户时区（DEC-056）：东八区租户在本地 10-20 零点后即可生成，UTC 仍是 10-19（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-timezone', { timezone: 'Asia/Shanghai' });
    const recordId = await w.transferWith('2026-10-20', fields);
    expect(await w.run('2026-10-19T15:00:00Z')).toMatchObject({ done: 0 });
    expect(await w.run('2026-10-19T16:30:00Z')).toMatchObject({ done: 1 });
    expect(await w.queue(recordId)).toMatchObject([{ state: 'done' }]);
  });
});

describe('AC-QL-sync 失败与重试（DEC-052）', () => {
  it('处理失败：state = failed、attempts + 1、记原因并退避；到点自动重试成功（AC-QL-sync）', async () => {
    const { w, fields } = await configured('qlsync-retry');
    const recordId = await w.transferWith('2026-10-05', fields);
    let fail = true;
    qualificationSyncProbe.beforeWrite = async () => {
      if (fail) throw new Error('模拟存储暂时不可用');
    };
    try {
      expect(await w.run('2026-10-10T05:00:00Z')).toMatchObject({ failed: 1, done: 0 });
      const [failed] = await w.queue(recordId);
      expect(failed).toMatchObject({ state: 'failed', attempts: 1 });
      expect(failed!.reason).toBeTruthy();
      expect(new Date(failed!.nextAttemptAt).getTime()).toBeGreaterThan(new Date('2026-10-10T05:00:00Z').getTime());
      expect(await w.subsets()).toEqual([]);

      // 退避期内不重试
      expect(await w.run('2026-10-10T05:00:10Z')).toMatchObject({ failed: 0, done: 0 });
      expect(await w.queue(recordId)).toMatchObject([{ attempts: 1 }]);

      fail = false;
      expect(await w.run('2026-10-10T07:00:00Z')).toMatchObject({ done: 1 });
      expect(await w.queue(recordId)).toMatchObject([{ state: 'done', attempts: 2 }]);
      expect(await w.subsets()).toHaveLength(1);
    } finally {
      qualificationSyncProbe.beforeWrite = undefined;
    }
  });
});

describe('AC-QL-sync 租户隔离与调度开关', () => {
  it('只处理本租户的队列行：另一租户的 pending 行不受影响（AC-QL-sync，租户隔离）', async () => {
    const a = await configured('qlsync-iso-a');
    const b = await configured('qlsync-iso-b');
    const recordA = await a.w.transferWith('2026-10-05', a.fields);
    const recordB = await b.w.transferWith('2026-10-05', b.fields);
    await a.w.run('2026-10-10T05:00:00Z');
    expect(await a.w.queue(recordA)).toMatchObject([{ state: 'done' }]);
    expect(await b.w.queue(recordB)).toMatchObject([{ state: 'pending' }]);
    expect(await b.w.subsets()).toEqual([]);
    // RLS：A 的会话读不到 B 的队列行
    const seen = await withTenant(a.w.db, a.w.tenantId, async (tx) =>
      rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM ev_sync_queue WHERE record_id=${recordB}::uuid`),
      ),
    );
    expect(seen[0]!.n).toBe(0);
  });

  it('环境变量可关：QUALIFICATION_SYNC_SCHEDULER=off 时进程不启动消费者（AC-QL-sync）', () => {
    expect(qualificationSyncSchedulerEnabled({})).toBe(true);
    expect(qualificationSyncSchedulerEnabled({ QUALIFICATION_SYNC_SCHEDULER: 'on' })).toBe(true);
    expect(qualificationSyncSchedulerEnabled({ QUALIFICATION_SYNC_SCHEDULER: 'off' })).toBe(false);
  });
});
