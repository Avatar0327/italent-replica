/** C2-1b / DEC-032：离职捕获独立于资格同步；先在 C2-1a 基线上验证缺失的订阅。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { f055World, rowsOf } from './AC-EMP-F055-support.js';

const database = useTestDb();

describe('AC-EV-leave-queue：离职 / 退休入队（设计 §4.3）', () => {
  it.each(['leave', 'retirement'] as const)('%s 保存即独立入队，重复事件按业务单判重', async (kind) => {
    const w = await f055World(database().db, `ev-leave-${kind}`);
    const employee = await w.session.getEmployee(w.subject.employee.id);
    const business = await w.session.business(
      employee.id,
      { kind, mode: 'direct', lastWorkDate: '2026-10-20' },
      employee.revision,
    );
    const queue = () =>
      withTenant(w.db, w.tenantId, async (tx) =>
        rowsOf<{ handler: string; dedupeKey: string; recordId: string; state: string }>(
          await tx.execute(sql`SELECT handler, dedupe_key AS "dedupeKey", record_id AS "recordId", state
            FROM ev_sync_queue WHERE tenant_id=${w.tenantId} AND record_id=${business.id}::uuid
            ORDER BY handler`),
        ),
      );
    const first = await queue();
    // 未来生效也须先捕获；消费时才按租户时区与有效时间轴复核。
    expect(first.filter((row) => row.handler === 'evaluation_leave')).toEqual([
      { handler: 'evaluation_leave', dedupeKey: business.id, recordId: business.id, state: 'pending' },
    ]);
    expect(first.filter((row) => row.handler === 'qualification_sync')).toHaveLength(1);
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO employment_outbox
        (tenant_id, employee_id, business_id, object_type, object_id, event_type, payload,
          state, command_id, payload_version_id, created_at)
        SELECT tenant_id, employee_id, business_id, object_type, object_id, event_type, payload,
          state, 'duplicate-' || gen_random_uuid()::text, payload_version_id, created_at
        FROM employment_outbox WHERE tenant_id=${w.tenantId} AND object_id=${business.id}::uuid
          AND event_type='employment.record.create' LIMIT 1`),
    );
    const repeated = await queue();
    expect(repeated.filter((row) => row.handler === 'evaluation_leave')).toEqual(
      first.filter((row) => row.handler === 'evaluation_leave'),
    );
    expect(repeated.filter((row) => row.handler === 'qualification_sync')).toHaveLength(2);
  });

  it('非离职事件只给资格同步入队，不进入离职处理器', async () => {
    const w = await f055World(database().db, 'ev-leave-non-leave');
    const recordId = await w.transfer('2026-10-20');
    const handlers = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ handler: string }>(
        await tx.execute(sql`SELECT handler FROM ev_sync_queue
          WHERE tenant_id=${w.tenantId} AND record_id=${recordId}::uuid`),
      ),
    );
    expect(handlers).toEqual([{ handler: 'qualification_sync' }]);
  });
});
