/** 对外事务端口：由调用方统一命令台账、权限、业务事务，合同侧仍写审计与 outbox。 */
import { and, eq, contractRecords, contractRequests, type Tx } from '@italent/db';
import { settings } from './configuration.js';
import { audit, checkScope, lockEmployee, type ContractContext } from './context.js';
import { createCommand, deleteContract, setContractState } from './service.js';
import type { ContractFields } from './input.js';
export async function handleContractsOnExit(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; lastWorkDate: string },
) {
  await lockEmployee(tx, ctx, input.employeeId);
  await checkScope(tx, ctx, input.employeeId);
  const config = await settings(tx, ctx.tenantId);
  await cancelExitRequests(tx, ctx, input, config.postExitTypeIds);
  const records = await tx
    .select()
    .from(contractRecords)
    .where(
      and(
        eq(contractRecords.tenantId, ctx.tenantId),
        eq(contractRecords.employeeId, input.employeeId),
        eq(contractRecords.deleted, false),
      ),
    );
  for (const record of records) {
    if (config.postExitTypeIds.includes(record.typeId) || record.status === 'void') continue;
    if (record.effectiveDate > input.lastWorkDate) await deleteContract(tx, ctx, record);
    else if ((!record.endDate || record.endDate > input.lastWorkDate) && record.status === 'valid') {
      await setContractState(tx, ctx, record, 'terminated', input.lastWorkDate);
    }
  }
}
export function generateContractForBusiness(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; fields: ContractFields },
) {
  return createCommand(tx, ctx, { ...input, operation: 'create', mode: 'direct' });
}
export function changeContractForTransfer(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; targetId: string; fields: ContractFields },
) {
  return createCommand(tx, ctx, { ...input, operation: 'change', mode: 'direct' });
}

async function cancelExitRequests(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; lastWorkDate: string },
  allowedTypes: string[],
) {
  const requests = await tx
    .select()
    .from(contractRequests)
    .where(and(eq(contractRequests.tenantId, ctx.tenantId), eq(contractRequests.employeeId, input.employeeId)))
    .orderBy(contractRequests.id);
  const { activeInstanceOf } = await import('../approval/store.js');
  const { cancel } = await import('../approval/actions.js');
  for (const request of requests) {
    if (
      allowedTypes.includes(request.typeId) ||
      request.effectiveDate <= input.lastWorkDate ||
      !['approved', 'in_review', 'returned'].includes(request.status)
    )
      continue;
    const active = await activeInstanceOf(tx, ctx.tenantId, 'contract', request.id);
    if (active) await cancel(tx, ctx, active.id);
    await tx
      .update(contractRequests)
      .set({ status: 'withdrawn', revision: request.revision + 1 })
      .where(eq(contractRequests.id, request.id));
    await audit(tx, ctx, 'contract.request.exit_delete', request.id, request, null);
  }
}
