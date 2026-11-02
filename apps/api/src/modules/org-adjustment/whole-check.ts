/**
 * 组织调整的整单关口（R2-T08 §4.4，BE-10c）：提交 / 重提、审批中编辑（改后的完整候选状态）、同意前兜底的唯一入口。
 * 基线过期 → 409 `ORG_ADJUSTMENT_BASELINE_CHANGED`；整单校验（与路由 7 同一份 checkWorld）有问题 → 400
 * `VALIDATION_FAILED`，`reason` 取首个问题、`items` 为全部问题。只读、不写数据；按字段裁剪由调用方做。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { assertWorldBaselines } from './baseline.js';
import type { ItemWorld } from './item-tree.js';
import { checkWorld } from './service.js';

export async function assertWhole(tx: Tx, world: ItemWorld, now: Date): Promise<void> {
  assertWorldBaselines(world);
  const { errors } = await checkWorld(tx, world, now);
  const first = errors[0] as { reason: string; message?: string } | undefined;
  if (first) {
    throw new AppError('VALIDATION_FAILED', first.message ?? '申请单校验未通过', {
      reason: first.reason,
      items: errors,
    });
  }
}
