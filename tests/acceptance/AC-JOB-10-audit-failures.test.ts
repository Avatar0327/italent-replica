import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { setAuditFallbackSink, type AuditFallbackRecord } from '@italent/api';
import { scenario, worker, versions, now } from './AC-JOB-sequence-support.js';
import { auditApi } from './AC-AUD-support.js';
import { resultRows } from './AC-ORG-people-support.js';
const testDb = useTestDb();
async function queue(db: Db) {
  const s = await scenario(db);
  const key = randomUUID();
  expect(
    (
      await s.call(
        'PATCH',
        `posts/${s.target.id}`,
        { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' },
        1,
        key,
      )
    ).status,
  ).toBe(200);
  return { ...s, key };
}
for (const unwritableAudit of [false, true])
  it(`AC-JOB-10 存储不可写全批回滚，失败审计${unwritableAudit ? '走兜底' : '可查'}，重试只记一次成功`, async () => {
    const { db } = testDb();
    const s = await queue(db);
    const before = await versions(db, s.world.tenant.id, s.employee.id);
    const fallback: AuditFallbackRecord[] = [];
    const reset = setAuditFallbackSink((record) => fallback.push(record));
    await db.execute(sql`CREATE FUNCTION f021_storage_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE='53100'; END $$`);
    await db.execute(
      sql`CREATE TRIGGER f021_fail BEFORE INSERT ON employment_payload_versions
      FOR EACH ROW EXECUTE FUNCTION f021_storage_failure()`,
    );
    if (unwritableAudit)
      await db.execute(
        sql`CREATE TRIGGER f021_audit_fail BEFORE INSERT ON audit_command_failures
      FOR EACH ROW EXECUTE FUNCTION f021_storage_failure()`,
      );
    try {
      expect(await worker(db, s.world.tenant.id)).toMatchObject({ failed: 1 });
    } finally {
      await db.execute(sql`DROP TRIGGER f021_fail ON employment_payload_versions`);
      if (unwritableAudit) await db.execute(sql`DROP TRIGGER f021_audit_fail ON audit_command_failures`);
      await db.execute(sql`DROP FUNCTION f021_storage_failure()`);
      reset();
    }
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
    const api = auditApi(db, now.toISOString());
    const as = { user: s.world.user.id, tenant: s.world.tenant.id };
    if (unwritableAudit)
      expect(fallback).toEqual([
        expect.objectContaining({ commandId: s.key, outcome: 'storage_unwritable', errorCode: '53100' }),
      ]);
    else
      expect((await api.commandFailures(as, { commandId: s.key })).items).toEqual([
        expect.objectContaining({ outcome: 'storage_unwritable', errorCode: '53100' }),
      ]);
    expect((await api.operationLogs(as, { objectType: 'job-sequence-sync', commandId: s.key })).items).toHaveLength(0);
    await worker(db, s.world.tenant.id);
    await worker(db, s.world.tenant.id);
    expect((await api.operationLogs(as, { objectType: 'job-sequence-sync', commandId: s.key })).items).toHaveLength(1);
    expect((await api.dataChanges(as, { objectType: 'employment-record', commandId: s.key })).items).toHaveLength(2);
  });
/** 第三个事务是单任务消费（前两个为租户及队列读取）；模拟提交响应丢失。 */
function lostCommit(db: Db, committed: boolean): Db {
  let n = 0;
  const wrapper = Object.create(db) as Db;
  const rollback = new Error('synthetic rollback');
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    if (++n !== 3) return db.transaction(fn);
    if (committed) await db.transaction(fn);
    else
      await db
        .transaction(async (tx) => {
          await fn(tx);
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
    throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  }) as Db['transaction'];
  return wrapper;
}
for (const committed of [false, true])
  it(`AC-JOB-10 提交响应丢失，回查${committed ? '确认成功' : '不能确认则unknown'}，重试不重复审计`, async () => {
    const { db } = testDb();
    const s = await queue(db);
    expect(await worker(lostCommit(db, committed), s.world.tenant.id)).toMatchObject(
      committed ? { completed: 1, failed: 0 } : { completed: 0, failed: 1 },
    );
    const failures = await withTenant(db, s.world.tenant.id, async (tx) =>
      resultRows(await tx.execute(sql`SELECT outcome FROM audit_command_failures WHERE command_id=${s.key}`)),
    );
    expect(failures).toEqual(committed ? [] : [{ outcome: 'unknown' }]);
    if (!committed)
      expect(
        await withTenant(db, s.world.tenant.id, async (tx) =>
          resultRows(
            await tx.execute(sql`SELECT a.state
      FROM employment_outbox_attempts a JOIN employment_outbox o ON o.id=a.outbox_id AND o.tenant_id=a.tenant_id
    WHERE o.command_id=${s.key} AND o.event_type='job.sequence-sync.requested' ORDER BY attempt_no DESC LIMIT 1`),
          ),
        ),
      ).toEqual([{ state: 'unknown' }]);
    await worker(db, s.world.tenant.id);
    await worker(db, s.world.tenant.id);
    const api = auditApi(db, now.toISOString());
    const as = { user: s.world.user.id, tenant: s.world.tenant.id };
    expect((await api.dataChanges(as, { objectType: 'employment-record', commandId: s.key })).items).toHaveLength(2);
    expect((await api.operationLogs(as, { objectType: 'job-sequence-sync', commandId: s.key })).items).toHaveLength(1);
  });
it('AC-JOB-10 消费事务尚未开始即断连，仍保留原命令关联的存储失败审计', async () => {
  const { db } = testDb();
  const s = await queue(db);
  let n = 0;
  const wrapper = Object.create(db) as Db;
  wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
    if (++n === 3) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    return db.transaction(fn);
  }) as Db['transaction'];
  expect(await worker(wrapper, s.world.tenant.id)).toMatchObject({ failed: 1 });
  const as = { user: s.world.user.id, tenant: s.world.tenant.id };
  expect((await auditApi(db, now.toISOString()).commandFailures(as, { commandId: s.key })).items).toEqual([
    expect.objectContaining({ outcome: 'storage_unwritable', commandId: s.key }),
  ]);
  await worker(db, s.world.tenant.id);
  expect(
    (await auditApi(db, now.toISOString()).operationLogs(as, { objectType: 'job-sequence-sync', commandId: s.key }))
      .items,
  ).toHaveLength(1);
});
