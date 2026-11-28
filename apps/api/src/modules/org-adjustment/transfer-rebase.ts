/**
 * 调动明细的基线刷新（R2-T08 §2.5 / §6.3 路由 8、9，BE-11c-b 第 2 轮 P2-3）：员工现行任职或 revision 在建行后被外部改动，
 * 提交 409 `ORG_ADJUSTMENT_BASELINE_CHANGED` 后，申请人显式刷新（单行或整单）把基线改成当前值再提交。
 * 刷新是“带权的确认”：先按申请人**当前**权限逐行走与保存同一条授权链（新建口径，事务内、锁住申请单之后），
 * 再重取基线；只确认版本，不豁免业务约束（范围、同日入职等仍由整单校验按生效日重判）。每行一条 `org-adjustment.rebase` 审计。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { ROW_NOT_FOUND } from './hidden-rows.js';
import { bumpRevision } from './items-store.js';
import { editable, type AdjustmentView, type WriteContext } from './service.js';
import { captureBaseline, type TransferGate, type TransferResult, type TransferWrite } from './transfer-items.js';
import { auditTransfer, loadTransfers, updateTransfer, type TransferItem } from './transfer-items-store.js';

/** 把这些行的基线刷到当前值；系统生成的行随来源行，不单独刷新。返回刷新后的行。 */
export async function rebaseTransferRows(
  tx: Tx,
  ctx: WriteContext,
  view: AdjustmentView,
  rows: readonly TransferItem[],
  gate: TransferGate,
): Promise<TransferItem[]> {
  const own = rows.filter((row) => !row.generatedByItemId);
  await gate.rejudge(tx, view, own);
  const scope = { adjustmentId: view.id, subjectOrgId: view.approvalSubjectOrgId };
  const refreshed: TransferItem[] = [];
  for (const row of own) {
    const base = await captureBaseline(tx, ctx.tenantId, row.employeeId, view.effectiveDate);
    const after: TransferItem = { ...row, baseRecordId: base.recordId, baseEmployeeRevision: base.revision };
    await updateTransfer(tx, after);
    await auditTransfer(tx, ctx, 'org-adjustment.rebase', scope, row, after);
    refreshed.push(after);
  }
  return refreshed;
}

/** 整单刷新里调动分区的部分：与组织明细同一次 revision + 1（由调用方的整单刷新统一加）。 */
export async function rebaseAllTransfers(tx: Tx, ctx: WriteContext, id: string, gate: TransferGate): Promise<void> {
  const view = await editable(tx, ctx, id);
  await rebaseTransferRows(tx, ctx, view, await loadTransfers(tx, ctx.tenantId, id), gate);
}

/** 路由 8（section = transfer）：单行刷新；隐藏行与不存在同一 404。 */
export async function rebaseTransferItem(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  itemId: string,
  gate: TransferGate,
  hidden: ReadonlySet<string>,
): Promise<TransferWrite> {
  const view = await editable(tx, ctx, id);
  const row = (await loadTransfers(tx, ctx.tenantId, id)).find((item) => item.id === itemId);
  if (!row || hidden.has(row.id)) throw new AppError('NOT_FOUND', ROW_NOT_FOUND);
  if (row.generatedByItemId) {
    throw new AppError('CONFLICT', '系统生成的调动明细随来源行，不能单独刷新', {
      reason: 'ORG_ADJUSTMENT_ITEM_GENERATED',
    });
  }
  const items = await rebaseTransferRows(tx, ctx, view, [row], gate);
  const result: TransferResult = { adjustmentId: id, revision: await bumpRevision(tx, ctx, id), items };
  return { status: 200, result };
}
