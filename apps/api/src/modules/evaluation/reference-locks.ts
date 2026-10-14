/**
 * B6 P2-2：活动 / 评价表写入的统一锁协议（设计 §7.4）。租户协调锁先于所有业务行锁，保证引用集合在取锁期间不变；
 * 评价表写入先按 ID 锁引用活动，再锁表单。活动写入先锁活动，再取表单显式 / 环节外键隐式锁，避免反向锁环。
 * 状态 / 报名命令仍可只锁活动：评价表等待活动后复核 EV-R5，不要求它们取协调锁。
 */
import { sql, type Tx } from '@italent/db';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { rowsOf } from './access.js';

export async function lockActivitiesForForm(tx: Tx, tenantId: string, formId: string) {
  // 不能按状态或报名数预过滤：首次发布 / 报名未提交时也须等锁并读取当前值。
  return rowsOf<{ status: string; apply_count: number }>(
    await tx.execute(sql`SELECT a.status, a.apply_count FROM ev_activities a
      WHERE a.tenant_id = ${tenantId}::uuid AND EXISTS (
        SELECT 1 FROM ev_chains c WHERE c.tenant_id = a.tenant_id AND c.activity_id = a.id
          AND c.form_id = ${formId}::uuid)
      ORDER BY a.id FOR SHARE OF a`),
  );
}

/** 创建 / 修改 / 删除活动与评价表均先调用；表单已有 ID 时先锁其引用活动，随后才能取表单行锁。 */
export async function coordinateActivityForms(tx: Tx, tenantId: string, formId?: string): Promise<void> {
  await advisoryLock(tx, 'evaluation:activity-forms:', asUuid(tenantId));
  if (formId) await lockActivitiesForForm(tx, tenantId, formId);
}
