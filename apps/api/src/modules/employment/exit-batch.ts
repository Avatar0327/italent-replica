/**
 * 批量离职申请（R2-T03 设计 §4 exits/batch、§9 合并待办；AC-DM-18）：≤ 100 人，每人一张离职申请并立即提交
 * （每人一条流程），同一 batch_id。整体成功或整体失败：每人在自己的保存点里执行，不满足的人只记原因、不影响其余人的判定，
 * 最后有任何一人不满足就整批 409 EXIT_BATCH_REJECTED（逐条原因），整个命令事务回滚、无任何写入（B-25）。
 * 逐人范围与权限在命令内复核（exitBatchGuard，replay-guard.ts），复核不过的人在这里只计原因、不执行。
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@italent/db';
import { employmentApprovalHooks } from './approval-hooks.js';
import { createExitApplication } from './exit-application.js';
import { lockEmploymentEmployee } from './record-store.js';
import { exitBatchFailure, exitBatchRejected, type ExitBatchFailure, type ExitBatchItem } from './replay-guard.js';
import { transitionEmployment } from './transitions.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';

export const EXIT_BATCH_LIMIT = 100;

/** 提交一张离职申请（专用 submit 入口与批量共用）：状态迁移 + 按审批类型匹配流程并发起，同一事务。 */
export async function submitExit(tx: Tx, ctx: EmploymentContext, id: string, ack?: string) {
  const business = await transitionEmployment(tx, ctx, { id, action: 'submit', ...(ack ? { ack } : {}) });
  await employmentApprovalHooks.submitted(tx, ctx, id);
  return business;
}

export async function createExitBatch(
  tx: Tx,
  ctx: EmploymentContext,
  items: readonly ExitBatchItem[],
  rejected: readonly ExitBatchFailure[],
): Promise<{ batchId: string; items: EmploymentBusiness[] }> {
  const batchId = randomUUID();
  const failures = [...rejected];
  const skipped = new Set(rejected.map((failure) => failure.index));
  const order = items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !skipped.has(index))
    .sort((a, b) => a.item.employeeId.localeCompare(b.item.employeeId) || a.index - b.index);
  // 锁序（org/locks.ts 全局序：员工 → 组织 → 编制 → 实例）：先按员工 ID 顺序一次锁齐全批员工，再逐人建单提交。
  // 提交会取组织锁，若边做边锁员工，就会出现“持组织锁再等员工锁”，与单人入口（先员工后组织）成环（真 PG 交错 ③）
  for (const { item, index } of order) {
    try {
      await lockEmploymentEmployee(tx, ctx, item.employeeId);
    } catch (error) {
      const failure = exitBatchFailure(index, item.employeeId, error);
      if (!failure) throw error;
      failures.push(failure);
      skipped.add(index);
    }
  }
  const created = new Map<number, EmploymentBusiness>();
  for (const { item, index } of order.filter((entry) => !skipped.has(entry.index))) {
    try {
      const business = await tx.transaction(async (savepoint) => {
        const draft = await createExitApplication(
          savepoint,
          { ...ctx, expectedRevision: item.revision },
          {
            employeeId: item.employeeId,
            initiation: 'hr',
            mode: 'application',
            lastWorkDate: item.lastWorkDate,
            exit: item.exit ?? {},
            batchId,
          },
        );
        return submitExit(savepoint, { ...ctx, expectedRevision: draft.revision }, draft.id);
      });
      created.set(index, business);
    } catch (error) {
      const failure = exitBatchFailure(index, item.employeeId, error);
      if (!failure) throw error;
      failures.push(failure);
    }
  }
  if (failures.length) throw exitBatchRejected(failures);
  return { batchId, items: items.map((_, index) => created.get(index)!) };
}
