/** 对外事务端口：由调用方统一命令台账、权限、业务事务，合同侧仍写审计与 outbox。 */
import { pgErrorCode, and, eq, contractRecords, contractRequests, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { settings } from './configuration.js';
import { audit, checkScope, lockEmployee, type ContractContext } from './context.js';
import { assertNoInFlight, createCommand, deleteContract, setContractState } from './service.js';
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
      await setContractState(tx, ctx, record, 'terminated', input.lastWorkDate, 'exit');
    }
  }
}
export function generateContractForBusiness(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; fields: ContractFields },
) {
  return portCommand(tx, { ...ctx, expectedRevision: 0 }, { ...input, operation: 'create', mode: 'direct' });
}
export function changeContractForTransfer(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; targetId: string; revision: number; fields: ContractFields },
) {
  const { revision, ...command } = input;
  return portCommand(tx, { ...ctx, expectedRevision: revision }, { ...command, operation: 'change', mode: 'direct' });
}
/**
 * 调动保存 / 提交 / 生效前查同类型在途合同：复用合同模块的统一判定（DEC-180② / F-016），调动侧不另写一套。
 * 拒绝时抛合同模块的 CONTRACT_IN_FLIGHT，由调用方映射为自己的机读原因。
 */
export function assertNoInFlightForTransfer(tx: Tx, ctx: ContractContext, employeeId: string, typeId: string) {
  return assertNoInFlight(tx, ctx, employeeId, typeId, 'change');
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

async function portCommand(tx: Tx, ctx: ContractContext, input: unknown) {
  try {
    // 保存点将数据库唯一约束失败回滚后转换为端口错误，外层业务事务仍由调用方控制。
    return await tx.transaction((sub) => createCommand(sub, ctx, input));
  } catch (error) {
    if (pgErrorCode(error) === '23505' && constraintName(error) === 'contract_records_number')
      throw new AppError('CONFLICT', '合同编号已存在');
    throw error;
  }
}

// postgres-js 使用 constraint_name，PGlite 使用 constraint；Drizzle 会包在 cause 内。
function constraintName(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const cause = current as { constraint?: string; constraint_name?: string; cause?: unknown };
    const name = cause.constraint_name ?? cause.constraint;
    if (name) return name;
    current = cause.cause;
  }
  return undefined;
}
