/**
 * F-476 P1 预检返工：办理份（approval_handling_contents）随租户备份导出、再恢复到新库后须原样往返。
 * 红点：披露上限为 null（不设上限）时旧实现写入 jsonb 的 'null' 字面量；恢复用 jsonb_populate_recordset，
 * 会把它变成 SQL NULL，撞上 NOT NULL（23502），整个租户恢复失败。
 */
import { restoreTenant } from '@italent/api';
import { exportTenantBackup, sql, withTenant, type Db } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();
const handles: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const handle of handles) await handle.close();
});

/** 办理日志 → 披露上限语义：null = 不设上限，数组 = 字段集合（排序后）。 */
async function ceilings(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = resultRows<{ log: string; ceiling: string[] | null }>(
      await tx.execute(sql`SELECT handling_log_id::text AS log, disclosure_ceiling AS ceiling
        FROM approval_handling_contents ORDER BY handling_log_id`),
    );
    return new Map(rows.map((row) => [row.log, row.ceiling === null ? null : [...row.ceiling].sort()]));
  });
}

describe('AC-F476-R2 办理份备份 → 恢复往返', () => {
  it('含“不设上限”（null）的办理份：恢复成功，行数与披露上限语义与原库一致', async () => {
    // approvalWorld 用无权限提供者的授权器：可见字段为 undefined → 办理份的披露上限写 null（不设上限）
    const w = await approvalWorld(testDb().db, 'f476-r2-restore');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const submitted = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const first = submitted.tasks.find((t) => t.status === 'pending')!;
    await w.json(await w.taskAction(s.outHead.userId, first.id, 'approve', submitted.revision));

    const before = await ceilings(w.db, w.tenant.id);
    expect(before.size).toBe(1);
    expect([...before.values()], '夹具须含 null 上限').toContain(null);

    const backup = await exportTenantBackup(w.db, { tenantId: w.tenant.id, codeVersion: 'f476-r2' }, cmd());
    const handle = await createTestDb();
    handles.push(handle);
    const report = await restoreTenant(
      handle.db,
      { backup, live: w.db, attachments: { sha256: async () => null } },
      cmd(),
      w.clock,
    );
    expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);

    const after = await ceilings(handle.db, w.tenant.id);
    expect(after).toEqual(before);
  }, 90_000);
});
