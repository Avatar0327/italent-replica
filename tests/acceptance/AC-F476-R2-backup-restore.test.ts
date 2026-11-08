/**
 * F-476 P1 预检返工：办理份（approval_handling_contents）随租户备份导出、再恢复到新库后须原样往返。
 * 红点：披露上限为 null（不设上限）时旧实现写入 jsonb 的 'null' 字面量；恢复用 jsonb_populate_recordset，
 * 会把它变成 SQL NULL，撞上 NOT NULL（23502），整个租户恢复失败。
 * P3-1：同一租户里再放“非空上限”与“空数组上限 []”各一份，三种语义恢复后都不得互相变形
 * （null 仍是 SQL NULL，不是 jsonb 'null'；[] 仍是空数组，不得变成 NULL——否则从“压到零字段”变成“不设上限”）。
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

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** 披露上限的存储语义：SQL NULL / jsonb 'null' / 数组（排序后）三者必须能区分，驱动解析会把前两者都读成 JS null。 */
type Ceiling = { kind: 'sql-null' } | { kind: 'json-null' } | { kind: 'array'; items: string[] };

/** 办理日志 → 披露上限语义。 */
async function ceilings(db: Db, tenantId: string): Promise<Map<string, Ceiling>> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = resultRows<{ log: string; isNull: boolean; type: string | null; items: string[] | null }>(
      await tx.execute(sql`SELECT handling_log_id::text AS log, disclosure_ceiling IS NULL AS "isNull",
          jsonb_typeof(disclosure_ceiling) AS type, disclosure_ceiling AS items
        FROM approval_handling_contents ORDER BY handling_log_id`),
    );
    return new Map(
      rows.map((row): [string, Ceiling] => {
        if (row.isNull) return [row.log, { kind: 'sql-null' }];
        if (row.type === 'array') return [row.log, { kind: 'array', items: [...row.items!].sort() }];
        return [row.log, { kind: 'json-null' }];
      }),
    );
  });
}

/**
 * 复制一份办理份并改披露上限：先为它另造一条合法的办理日志（同实例 / 轮次 / 办理人、新序号），
 * 守卫触发器照常校验（任务可有多份）。ceilingSql 是 jsonb 字面量文本。
 */
async function cloneWithCeiling(tx: Tx, ceilingSql: string) {
  await tx.execute(sql`INSERT INTO approval_instance_logs
      (id, tenant_id, instance_id, seq, round, node_key, task_id, event, actor_user_id, detail)
    SELECT gen_random_uuid(), l.tenant_id, l.instance_id,
      (SELECT max(seq) + 1 FROM approval_instance_logs WHERE tenant_id = l.tenant_id AND instance_id = l.instance_id),
      l.round, l.node_key, l.task_id, l.event, l.actor_user_id, l.detail
    FROM approval_instance_logs l
    WHERE l.id = (SELECT handling_log_id FROM approval_handling_contents ORDER BY created_at LIMIT 1)`);
  await tx.execute(sql`CREATE TEMP TABLE f476_r2_clone ON COMMIT DROP AS
    SELECT * FROM approval_handling_contents ORDER BY created_at LIMIT 1`);
  await tx.execute(sql`UPDATE f476_r2_clone SET id = gen_random_uuid(),
    handling_log_id = (SELECT id FROM approval_instance_logs
      WHERE tenant_id = f476_r2_clone.tenant_id AND instance_id = f476_r2_clone.instance_id ORDER BY seq DESC LIMIT 1),
    disclosure_ceiling = ${ceilingSql}::jsonb`);
  await tx.execute(sql`INSERT INTO approval_handling_contents SELECT * FROM f476_r2_clone`);
}

describe('AC-F476-R2 办理份备份 → 恢复往返', () => {
  it('null / 非空 / 空数组 三种披露上限：恢复成功，行数与每条上限语义与原库一致', async () => {
    // approvalWorld 用无权限提供者的授权器：可见字段为 undefined → 办理份的披露上限写 SQL NULL（不设上限）
    const w = await approvalWorld(testDb().db, 'f476-r2-restore');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const submitted = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const first = submitted.tasks.find((t) => t.status === 'pending')!;
    await w.json(await w.taskAction(s.outHead.userId, first.id, 'approve', submitted.revision));
    // 另两份：非空上限（故意乱序，核对排序后相等）与空数组上限
    await withTenant(w.db, w.tenant.id, (tx) => cloneWithCeiling(tx, '["employeeId","departmentId","effectiveDate"]'));
    await withTenant(w.db, w.tenant.id, (tx) => cloneWithCeiling(tx, '[]'));

    const before = await ceilings(w.db, w.tenant.id);
    const kinds = [...before.values()].map((c) => c.kind).sort();
    expect(kinds, '夹具须同时含 SQL NULL、非空数组、空数组').toEqual(['array', 'array', 'sql-null']);
    const arrays = [...before.values()].flatMap((c) => (c.kind === 'array' ? [c.items.length] : [])).sort();
    expect(arrays).toEqual([0, 3]);

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
    expect(after.size).toBe(before.size);
    // 同一条办理日志在恢复前后语义一致：null 仍为 SQL NULL，数组排序后相等，[] 仍为 []
    expect(after).toEqual(before);
  }, 90_000);
});
