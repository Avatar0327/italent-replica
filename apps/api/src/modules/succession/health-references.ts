/** 审查 P2-2：计划映射、执行写回和等级删除共用规则集合锁，连接跨事务的冻结引用。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { lockRuleSettings } from './config-store.js';
import { rowsOf } from './read-sql.js';

export const lockHealthRules = (tx: Tx, tenantId: string) => lockRuleSettings(tx, tenantId, 'org_health');

/** 调用方已持 lockHealthRules；完成 / 终止计划不再占用引用，落库结果继续由 B5 外键保护。 */
export async function requireHealthLevelUnplanned(tx: Tx, tenantId: string, levelId: string) {
  const active = rowsOf(
    await tx.execute(sql`SELECT 1 FROM succession_sync_targets t
    JOIN succession_sync_batches b ON b.tenant_id=t.tenant_id AND b.id=t.batch_id
    WHERE t.tenant_id=${tenantId}::uuid AND t.target_kind='org_health' AND t.health_level_id=${levelId}::uuid
      AND (t.status='pending' OR (t.status='failed' AND t.retryable))
      AND b.status NOT IN ('completed','terminated','rejected') LIMIT 1`),
  );
  if (active.length) throw new AppError('CONFLICT', '等级已被同步计划引用', { reason: 'LEVEL_IN_USE' });
}
