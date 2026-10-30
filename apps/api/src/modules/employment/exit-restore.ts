/**
 * 撤销已生效离职后的“恢复入口”（R2-T03 设计 §5.8 末、§7.1，第 1 轮审查 P2-1 / P2-2 / P2-4，DEC-431① 单一入口）。
 * 离职自己的时间轴行已被 removeEmploymentTimeline 移除后，恢复时间轴与关联状态只经这里，按固定顺序：
 *  ① 挂回候选筛选与时间轴（reattachFutureTransfers：只挂回仍在“被摘下”状态的调动，已删除 / 墓碑的不挂回）；
 *  ② 按最终窗口做恢复守卫（前一条 A 的 [E′, S) 与每个挂回的 T 各一次；部门停用与严格编制交 §6B）；
 *  ③ 同事务同步前驱与挂回的 T 的人员履历（前驱的结束日随时间轴恢复开放，保留“返回前驱”的既有契约）；
 *  ④ T 的“员工已离职”失败待办收敛：待办由最近一次有效尝试派生（activation-store.ts STALE_DEPARTED_FAILURE），T 回到时间轴即失效，
 *     尝试历史行原样保留；T 尚未到期的联动不被标为已完成。
 * 下游结果（撤销清单里“已挂回”的附加项）由 exit-downstream.ts 按实际回到时间轴的目标报告。
 * approved 撤销没有时间轴写入，不经这里（仅状态迁移 + 预减随状态收回）；通用 DELETE 与 POST exits/:id/cancel 都先到 cancelExit。
 */
import type { Tx } from '@italent/db';
import { assertRestoredPredecessor } from './deletion-guards.js';
import { loadEmploymentRecord } from './read-model.js';
import { personnelHooks } from './personnel-hooks.js';
import { reattachFutureTransfers } from './timeline.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

/** 返回时间轴上的前一条（供调用方同步其投影）；没有前一条返回 null。 */
export async function restoreAfterExitDeletion(
  tx: Tx,
  ctx: EmploymentContext,
  deleted: EmploymentRecord,
  exit: { readonly id: string; readonly employeeId: string },
  point: { recordId: string; window: { from: string; to: string | null } },
  until?: string,
): Promise<{ id: string; kind: string; date: string } | null> {
  const reattached = await reattachFutureTransfers(tx, ctx, exit.employeeId, exit.id);
  const delegate = { delegateIntervalChecks: true };
  const bound = (window: { from: string; to: string | null }) => ({
    ...window,
    to: until && (!window.to || until < window.to) ? until : window.to,
  });
  const finalWindow = bound({ from: point.window.from, to: reattached[0]?.from ?? point.window.to });
  if (!finalWindow.to || finalWindow.from < finalWindow.to)
    await assertRestoredPredecessor(tx, ctx, deleted, { previousId: point.recordId, window: finalWindow }, delegate);
  for (const item of reattached) {
    if (!until || item.from < until)
      await assertRestoredPredecessor(tx, ctx, deleted, { previousId: item.recordId, window: bound(item) }, delegate);
    await personnelHooks.sync(tx, ctx, exit.employeeId, item.recordId, 'transfer', item.from);
  }
  const kept = await loadEmploymentRecord(tx, ctx.tenantId, point.recordId, finalWindow.from);
  return kept ? { id: kept.id, kind: kept.kind, date: kept.effectiveDate } : null;
}
