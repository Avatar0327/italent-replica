/** DEC-447：只构造真实 outbox 的订阅队列，不实现 C2-1b 的入队或终止业务。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { vi } from 'vitest';
import type { EmploymentOutboxConsumer } from '../../apps/api/src/modules/employment/outbox-consumer.js';
import { f055World, rowsOf } from './AC-EMP-F055-support.js';

export async function leaveConsumerWorld(db: Db, label: string) {
  const w = await f055World(db, label);
  const recordId = await w.leave('2026-10-04');
  const enqueue = (kind: string, id = recordId) =>
    withTenant(db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO ev_sync_queue
          (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
        SELECT tenant_id, ${kind}, business_id::text, id, employee_id, object_id, '2026-10-01'::timestamptz
        FROM employment_outbox WHERE tenant_id=${w.tenantId} AND object_id=${id}::uuid
          AND event_type='employment.record.create' ON CONFLICT DO NOTHING`),
    );
  const queue = (kind: string) =>
    withTenant(db, w.tenantId, async (tx) =>
      rowsOf<{ state: string; attempts: number; reason: string | null; recordId: string }>(
        await tx.execute(sql`SELECT state, attempts, reason, record_id AS "recordId" FROM ev_sync_queue
          WHERE tenant_id=${w.tenantId} AND handler=${kind} ORDER BY created_at, id`),
      ),
    );
  return { ...w, recordId, enqueue, queue };
}

export function testConsumer(kind = `test_leave_${randomUUID().replaceAll('-', '')}`): EmploymentOutboxConsumer {
  return {
    kind,
    commandPrefix: `test-${kind}`,
    label: '测试离职消费',
    handle: vi.fn(async () => ({ state: 'done' as const, reason: null })),
  };
}

export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
