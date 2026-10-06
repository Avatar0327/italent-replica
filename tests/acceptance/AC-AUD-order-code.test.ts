/**
 * PR #75 第二轮 P2-6：人员序码重算的集合写入同样经统一审计口径——操作类型、字段差异、来源（手动重算带请求 TraceID，
 * 定时重算记“系统 / 定时任务”），原子批量 SQL 与 outbox 保持不变。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOrderCodeJobs } from '../../apps/api/src/modules/personnel/order-code-scheduler.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';
import { employmentSession } from './AC-EMP-support.js';
import { auditApi, SOURCE_HEADERS } from './AC-AUD-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const clock = () => new Date(NOW);

describe('P2-6 人员序码重算的审计', () => {
  it('手动重算带请求来源；定时重算记系统与定时任务；两者都有操作类型与字段差异，可按字段筛选', async () => {
    const db = database().db;
    const w = await employmentSession(db, 'aud-order-code');
    const first = await w.employee('序码甲', 'A');
    await w.business(first.id, { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: {} }, 1);
    const api = tenantApi(db, { clock });
    const as = { user: w.user.id, tenant: w.tenant.id };
    const settings = await api.request('PUT', '/api/tenant/personnel/order-code/settings', {
      ...as,
      ifMatch: 0,
      body: { enabled: true, items: [{ field: 'code', direction: 'asc', enabled: true }] },
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const manual = await api.request('POST', '/api/tenant/personnel/order-code/recompute', {
      ...as,
      ifMatch: 1,
      body: {},
      headers: SOURCE_HEADERS,
    });
    expect(manual.status, await manual.clone().text()).toBe(200);

    const second = await w.employee('序码乙', 'B');
    await w.business(second.id, { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: {} }, 1);
    const run = await runOrderCodeJobs(db, { clock });
    expect(run.failures).toEqual([]);

    const audits = await withTenant(db, w.tenant.id, async (tx) =>
      rows<Record<string, unknown>>(
        await tx.execute(sql`SELECT object_id,actor_user_id,operation,changes,source_action,trace_id
          FROM audit_events WHERE action='personnel.order.recompute' ORDER BY occurred_at,object_id`),
      ),
    );
    const manualRow = audits.find((row) => row.object_id === first.id);
    expect(manualRow).toMatchObject({
      actor_user_id: w.user.id,
      operation: 'create',
      trace_id: 'trace-aud-01',
      changes: [expect.objectContaining({ field: 'orderCode', from: null, to: 1 })],
    });
    const scheduledRow = audits.find((row) => row.object_id === second.id);
    expect(scheduledRow).toMatchObject({
      actor_user_id: null,
      operation: 'create',
      source_action: '定时任务',
      changes: [expect.objectContaining({ field: 'orderCode', to: 2 })],
    });
    const byField = await auditApi(db, NOW).dataChanges(as, { field: 'orderCode', limit: '100' });
    expect(new Set(byField.items.map((item) => item.objectId))).toEqual(new Set([first.id, second.id]));
  });
});
