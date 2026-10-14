/**
 * 同步计划屏障的判定点（设计 §1.2、§7；拆分方案 A2 / D1）：目标上有未完成的同步计划时，手动写入（新增 / 编辑 / 结束 /
 * 删除）一律 409 TARGET_SYNC_IN_PROGRESS——计划与手动写入不交错。屏障 = 批次处于 executing / blocked，或首次计划事务已提交，
 * 且该目标 pending / failed ∧ retryable。
 * D1 默认查询持久计划屏障；测试可替换探针。判定必须在持有目标锁
 * 之后调用（§7：计划行在目标锁内写入并与读旧集合同事务提交，手动事务取同一目标锁后一定看到已提交的屏障）。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from './read-sql.js';
import type { SuccessionType } from '@italent/db';
import { AppError } from '../../errors.js';

export interface BarrierTarget {
  readonly kind: SuccessionType | 'org_health';
  readonly id: string;
}

/** 返回 true = 这些目标里至少一个有屏障。 */
export type SyncBarrierProbe = (tx: Tx, tenantId: string, targets: readonly BarrierTarget[]) => Promise<boolean>;

let probe: SyncBarrierProbe | undefined;

/** 测试探针；传 undefined 恢复真实数据库判定。 */
export function setSyncBarrier(next: SyncBarrierProbe | undefined): void {
  probe = next;
}

export async function assertNoSyncBarrier(tx: Tx, tenantId: string, targets: readonly BarrierTarget[]): Promise<void> {
  if (await (probe ?? persistentBarrier)(tx, tenantId, targets)) {
    throw new AppError('CONFLICT', '目标存在未完成的同步计划，请稍后再试', { reason: 'TARGET_SYNC_IN_PROGRESS' });
  }
}

async function persistentBarrier(tx: Tx, tenantId: string, targets: readonly BarrierTarget[]): Promise<boolean> {
  if (!targets.length) return false;
  const wanted = targets.map(({ kind, id }) => sql`(p.target_kind = ${kind} AND p.target_id = ${id}::uuid)`);
  return (
    rowsOf(
      await tx.execute(sql`SELECT 1 FROM succession_sync_targets p
    JOIN succession_sync_batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
    WHERE p.tenant_id = ${tenantId}::uuid AND b.has_plan AND b.status IN ('executing','blocked')
      AND (p.status = 'pending' OR (p.status = 'failed' AND p.retryable))
      AND (${sql.join(wanted, sql` OR `)}) LIMIT 1`),
    ).length > 0
  );
}
