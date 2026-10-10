/**
 * 同步计划屏障的判定点（设计 §1.2、§7；拆分方案 A2 / D1）：目标上有未完成的同步计划时，手动写入（新增 / 编辑 / 结束 /
 * 删除）一律 409 TARGET_SYNC_IN_PROGRESS——计划与手动写入不交错。屏障 = 批次处于 executing / blocked，或首次计划事务已提交，
 * 且该目标 pending / failed ∧ retryable。
 * 本 PR（A2）还没有批次表，恒为“无屏障”；D1 建批次与目标计划表后用 `setSyncBarrier` 接入真实判定。判定必须在持有目标锁
 * 之后调用（§7：计划行在目标锁内写入并与读旧集合同事务提交，手动事务取同一目标锁后一定看到已提交的屏障）。
 */
import type { Tx } from '@italent/db';
import type { SuccessionType } from '@italent/db';
import { AppError } from '../../errors.js';

export interface BarrierTarget {
  readonly kind: SuccessionType;
  readonly id: string;
}

/** 返回 true = 这些目标里至少一个有屏障。 */
export type SyncBarrierProbe = (tx: Tx, tenantId: string, targets: readonly BarrierTarget[]) => Promise<boolean>;

let probe: SyncBarrierProbe | undefined;

/** D1 接入真实判定；传 undefined 恢复“无屏障”。 */
export function setSyncBarrier(next: SyncBarrierProbe | undefined): void {
  probe = next;
}

export async function assertNoSyncBarrier(tx: Tx, tenantId: string, targets: readonly BarrierTarget[]): Promise<void> {
  if (probe && (await probe(tx, tenantId, targets))) {
    throw new AppError('CONFLICT', '目标存在未完成的同步计划，请稍后再试', { reason: 'TARGET_SYNC_IN_PROGRESS' });
  }
}
