/**
 * 审批中心的组织调整适配器（R2-T08 设计 §4.1～4.5、§14.1，BE-10c）。
 * - 锁：申请单行 FOR UPDATE（单张 / 批量按 ID 升序），不取组织锁——审批事务不改组织，组织写入只在 11a 执行时发生；
 * - 快照：头（含调整范围）+ 组织分区（snapshot.ts）；
 * - 同意前：整单关口兜底（基线 + 整单校验，与提交 / 审批中编辑同一入口 whole-check，DEC-644 A-8）；不同意 / 驳回不判；
 * - 回写：通过 → 2 并在同一事务排期入队（BE-11b，§7.1 数据量与 S 不含暂存行）、驳回 → 6、不同意 → 3、审批侧撤回 → 0；
 * - 重提：只接受已驳回单、不带修正，按提交口径重判（submission.ts）；
 * - 审批中编辑：approval-edit.ts（OA-R7）。
 */
import { sql, type Tx } from '@italent/db';
import { ORG_ADJUSTMENT_APPROVAL_STATUS as STATUS } from '@italent/domain';
import type { BusinessAdapter } from '../approval/adapters.js';
import type { ApprovalContext } from '../approval/context.js';
import { assertApprovable, editFromApproval } from './approval-edit.js';
import { scheduleOrgAdjustmentExecution } from './schedule.js';
import { orgAdjustmentSnapshot } from './snapshot.js';
import { resubmitFromApproval, settleApproval, settleFromApproval } from './submission.js';

async function lockRows(tx: Tx, ctx: ApprovalContext, ids: readonly string[]) {
  const sorted = [...new Set(ids)].sort();
  if (!sorted.length) return;
  await tx.execute(sql`SELECT id FROM org_adjustments
    WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(
      sorted.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) ORDER BY id FOR UPDATE`);
}

export const orgAdjustmentAdapter: BusinessAdapter = {
  lock: (tx, ctx, id) => lockRows(tx, ctx, [id]),
  lockMany: (tx, ctx, ids) => lockRows(tx, ctx, ids),
  snapshot: (tx, ctx, id) => orgAdjustmentSnapshot(tx, ctx.tenantId, id),
  beforeApprove: async (tx, ctx, id, _nodeKey, decision) => {
    if (decision === 'approve') await assertApprovable(tx, ctx, id);
  },
  approved: async (tx, ctx, id) => {
    if (await settleApproval(tx, ctx, id, STATUS.approved, 'approved'))
      await scheduleOrgAdjustmentExecution(tx, ctx, id);
  },
  rejected: settleFromApproval(STATUS.rejected, 'rejected'),
  disapproved: settleFromApproval(STATUS.notApproved, 'disapproved'),
  withdrawn: settleFromApproval(STATUS.staged, 'withdraw'),
  resubmit: resubmitFromApproval,
  edit: editFromApproval,
};
