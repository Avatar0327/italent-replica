/** B6 / EV-R5：只锁已发布且已有报名的活动引用；先按活动 ID 取共享锁，再读状态与报名数。 */
import { sql, type Tx } from '@italent/db';
import { registerFormLock } from './form-lock.js';
import { rowsOf } from './store.js';

async function activityFormLocked(tx: Tx, tenantId: string, formId: string): Promise<boolean> {
  // 不能先过滤 status / apply_count：另一事务首次发布或报名尚未提交时也要等行锁，拿锁后按当前值判（设计 §7.4）。
  const rows = rowsOf<{ status: string; apply_count: number }>(
    await tx.execute(sql`
    SELECT a.status, a.apply_count FROM ev_activities a
    WHERE a.tenant_id = ${tenantId}::uuid AND EXISTS (
      SELECT 1 FROM ev_chains c WHERE c.tenant_id = a.tenant_id AND c.activity_id = a.id
        AND c.form_id = ${formId}::uuid)
    ORDER BY a.id FOR SHARE OF a`),
  );
  return rows.some((row) => row.status === 'published' && Number(row.apply_count) > 0);
}

export function registerActivityFormLock(): void {
  registerFormLock(activityFormLocked);
}
