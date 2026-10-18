/** 对外事务端口：由调用方统一命令台账、权限、业务事务，合同侧仍写审计与 outbox。 */
import { pgErrorCode, and, eq, contractRecords, contractRequests, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { settings } from './configuration.js';
import { audit, checkScope, lockEmployee, type ContractContext } from './context.js';
import { assertNoInFlight, createCommand, deleteContract, setContractState } from './service.js';
import type { ContractFields } from './input.js';
/** 离职生效对合同的后果清单（设计 §5.4-1）：离职侧据此写 exit_effects、发站内消息；字段只含 ID、类型与日期。 */
export interface ExitContractOutcome {
  readonly terminated: readonly { id: string; typeId: string; effectiveDate: string; endDate: string | null }[];
  readonly deleted: readonly { id: string; typeId: string; effectiveDate: string; endDate: string | null }[];
  readonly withdrawnRequests: readonly {
    id: string;
    typeId: string;
    operation: string;
    effectiveDate: string;
    stateBefore: string;
    instanceId: string | null;
    initiatorUserId: string | null;
  }[];
}

/**
 * 离职生效时（编排器步骤 4，L′ 为最终最后工作日）：撤回全部在途合同申请（不分生效日，DEC-496①；“离职后可签类型”豁免），
 * 起始日晚于 L′ 的合同软删除，有效且终止日为空或晚于 L′ 的合同原地终止。
 */
export async function handleContractsOnExit(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; lastWorkDate: string },
): Promise<ExitContractOutcome> {
  await lockEmployee(tx, ctx, input.employeeId);
  await checkScope(tx, ctx, input.employeeId);
  const config = await settings(tx, ctx.tenantId);
  const withdrawnRequests = await cancelExitRequests(tx, ctx, input, config.postExitTypeIds);
  const records = await tx
    .select()
    .from(contractRecords)
    .where(
      and(
        eq(contractRecords.tenantId, ctx.tenantId),
        eq(contractRecords.employeeId, input.employeeId),
        eq(contractRecords.deleted, false),
      ),
    )
    .orderBy(contractRecords.id);
  const terminated: ExitContractOutcome['terminated'][number][] = [];
  const deleted: ExitContractOutcome['deleted'][number][] = [];
  for (const record of records) {
    if (config.postExitTypeIds.includes(record.typeId) || record.status === 'void') continue;
    const summary = {
      id: record.id,
      typeId: record.typeId,
      effectiveDate: record.effectiveDate,
      endDate: record.endDate,
    };
    if (record.effectiveDate > input.lastWorkDate) {
      await deleteContract(tx, ctx, record);
      deleted.push(summary);
    } else if ((!record.endDate || record.endDate > input.lastWorkDate) && record.status === 'valid') {
      await setContractState(tx, ctx, record, 'terminated', input.lastWorkDate, 'exit');
      terminated.push(summary);
    }
  }
  return { terminated, deleted, withdrawnRequests };
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
  input: { employeeId: string },
  allowedTypes: string[],
): Promise<ExitContractOutcome['withdrawnRequests'][number][]> {
  const requests = await tx
    .select()
    .from(contractRequests)
    .where(and(eq(contractRequests.tenantId, ctx.tenantId), eq(contractRequests.employeeId, input.employeeId)))
    .orderBy(contractRequests.id);
  const { activeInstanceOf } = await import('../approval/store.js');
  const { cancel } = await import('../approval/actions.js');
  const withdrawn: ExitContractOutcome['withdrawnRequests'][number][] = [];
  for (const request of requests) {
    if (allowedTypes.includes(request.typeId) || !['approved', 'in_review', 'returned'].includes(request.status))
      continue;
    const active = await activeInstanceOf(tx, ctx.tenantId, 'contract', request.id);
    if (active) await cancel(tx, ctx, active.id);
    await tx
      .update(contractRequests)
      .set({ status: 'withdrawn', revision: request.revision + 1 })
      .where(eq(contractRequests.id, request.id));
    await audit(tx, ctx, 'contract.request.exit_delete', request.id, request, null);
    withdrawn.push({
      id: request.id,
      typeId: request.typeId,
      operation: request.operation,
      effectiveDate: request.effectiveDate,
      stateBefore: request.status,
      instanceId: active?.id ?? null,
      initiatorUserId: active?.initiatorUserId ?? null,
    });
  }
  return withdrawn;
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
