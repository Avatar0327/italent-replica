/**
 * R1-T16 失败命令审计（AGENTS.md §10「审计」：业务失败、存储不可写、结果未知分三类记录；PR #1 Codex 审计转入，
 * docs/08_设计/R1-T00 §8）。失败命令的业务写入整体回滚，失败审计在独立事务里另写一条，不伪造成功审计；
 * 审计库也写不进去时落到兜底通道（进程日志），仍按三类标注。结果未知的分类在 apps/api/src/commands.test.ts 用替身库覆盖。
 */
import { randomUUID } from 'node:crypto';
import { type AuditFallbackRecord, setAuditFallbackSink } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, EMP_TODAY, withLoginEmail } from './AC-EMP-support.js';
import { auditApi, SOURCE_HEADERS } from './AC-AUD-support.js';
import { resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();
const NOW = `${EMP_TODAY}T01:00:00.000Z`;

async function failingTrigger(table: string, errcode: string) {
  const { db } = testDb();
  const fn = `aud_fail_${table}`;
  await db.execute(
    sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic storage failure' USING ERRCODE = '${errcode}'; END $$`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER ${fn}_trigger BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${fn}()`),
  );
  return async () => {
    await db.execute(sql.raw(`DROP TRIGGER ${fn}_trigger ON ${table}`));
    await db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
  };
}

describe('失败命令三类审计', () => {
  it('业务失败：revision 过期的写入 409，留一条「业务失败」记录（带来源信息），业务数据不变', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'aud-fail-business');
    const employee = await session.employee();
    const commandId = randomUUID();
    const stale = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision + 3,
      idempotencyKey: commandId,
      body: withLoginEmail(employee.id, { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' }),
      headers: SOURCE_HEADERS,
    });
    expect(stale.status).toBe(409);
    const as = { user: session.user.id, tenant: session.tenant.id };
    const { items } = await auditApi(db, NOW).commandFailures(as, { commandId });
    expect(items).toEqual([
      expect.objectContaining({
        outcome: 'business_failed',
        outcomeLabel: '业务失败',
        errorCode: 'REVISION_CONFLICT',
        method: 'POST',
        // 路径里的对象编号打码（DEC-197）
        path: '/api/tenant/employment/employees/:id/businesses',
        operator: { userId: session.user.id, name: session.user.displayName },
        occurredAt: NOW,
      }),
    ]);
    expect(items[0]).toMatchObject({ ip: '203.0.113.7', traceId: 'trace-aud-01' });
    expect(await session.records(employee.id)).toEqual([]);
    // 失败审计不进数据变更日志，也不进命令台账：客户端可按原键修正后重提
    const ok = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      idempotencyKey: randomUUID(),
      body: withLoginEmail(employee.id, { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' }),
    });
    expect(ok.status).toBe(201);
  });

  it('存储不可写：磁盘满等存储错误返回 503，记一条「存储不可写」，业务、台账与数据变更日志全部回滚', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'aud-fail-storage');
    const employee = await session.employee();
    const commandId = randomUUID();
    const restore = await failingTrigger('employment_outbox', '53100');
    try {
      const failed = await session.request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: employee.revision,
        idempotencyKey: commandId,
        body: withLoginEmail(employee.id, { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' }),
      });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE', details: { reason: 'STORAGE_UNWRITABLE' } },
      });
    } finally {
      await restore();
    }
    const as = { user: session.user.id, tenant: session.tenant.id };
    const { items } = await auditApi(db, NOW).commandFailures(as, { commandId });
    expect(items).toEqual([
      expect.objectContaining({ outcome: 'storage_unwritable', outcomeLabel: '存储不可写', errorCode: '53100' }),
    ]);
    await withTenant(db, session.tenant.id, async (tx) => {
      for (const table of ['audit_events', 'command_ledger', 'employment_outbox']) {
        const rows = resultRows(
          await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE command_id=${commandId} LIMIT 1`),
        );
        expect(rows, table).toEqual([]);
      }
    });
  });

  it('审计库也不可写：失败记录落到兜底通道，不丢、不伪造', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'aud-fail-fallback');
    const employee = await session.employee();
    const commandId = randomUUID();
    const captured: AuditFallbackRecord[] = [];
    const resetSink = setAuditFallbackSink((record) => captured.push(record));
    const restoreBusiness = await failingTrigger('employment_outbox', '53100');
    const restoreAudit = await failingTrigger('audit_command_failures', '53100');
    try {
      const failed = await session.request('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: employee.revision,
        idempotencyKey: commandId,
        body: withLoginEmail(employee.id, { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' }),
      });
      expect(failed.status).toBe(503);
    } finally {
      await restoreAudit();
      await restoreBusiness();
      resetSink();
    }
    expect(captured).toEqual([
      expect.objectContaining({
        tenantId: session.tenant.id,
        commandId,
        outcome: 'storage_unwritable',
        errorCode: '53100',
        method: 'POST',
      }),
    ]);
    const as = { user: session.user.id, tenant: session.tenant.id };
    expect((await auditApi(db, NOW).commandFailures(as, { commandId })).items).toEqual([]);
  });
});
