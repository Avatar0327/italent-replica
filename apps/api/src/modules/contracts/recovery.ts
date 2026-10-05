/** DEC-180③：无法生效的已批准申请可撤销，再以当前数据发起修复后的新命令。 */
import { and, eq, sql, contractRequests, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { audit, checkScope, lockEmployee, revision, rowsOf, type ContractContext } from './context.js';
import { loadRequest } from './service.js';

export async function cancelFailedRequest(tx: Tx, ctx: ContractContext, id: string) {
  const initial = await loadRequest(tx, ctx.tenantId, id);
  await lockEmployee(tx, ctx, initial.employeeId);
  await tx.execute(sql`SELECT id FROM contract_requests WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid FOR UPDATE`);
  const before = await loadRequest(tx, ctx.tenantId, id);
  await checkScope(tx, ctx, before.employeeId, before.createdBy);
  revision(ctx.expectedRevision, before.revision);
  const due = before.operation === 'terminate' ? before.actualTerminationDate! : before.effectiveDate;
  const [failure] = rowsOf(
    await tx.execute(sql`SELECT id FROM contract_job_attempts
    WHERE tenant_id=${ctx.tenantId} AND object_id=${id}::uuid AND kind='activate' AND state IN ('failed','unknown')`),
  );
  if (before.status !== 'approved' || due > tenantLocalDate(ctx.now, ctx.timezone) || !failure)
    throw new AppError('CONFLICT', '只有到期生效失败的已批准合同申请可以撤销', { reason: 'CONTRACT_NOT_FAILED' });
  const [after] = await tx
    .update(contractRequests)
    .set({ status: 'withdrawn', revision: before.revision + 1 })
    .where(and(eq(contractRequests.tenantId, ctx.tenantId), eq(contractRequests.id, id)))
    .returning();
  // 已结束的审批记录保留原批准结论，业务撤销作为独立审计事件，不代签、不重放节点。
  await audit(tx, ctx, 'contract.request.cancel', id, before, after);
  return after!;
}
