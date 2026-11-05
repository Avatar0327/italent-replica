/** 对外事务端口：由调用方统一命令台账、权限、业务事务，合同侧仍写审计与 outbox。 */
import { pgErrorCode, and, eq, contractRecords, contractRequests, type Tx } from '@italent/db';
import { contractOperationFlow, terminatedByExit, type ExitTerminationSetting } from '@italent/domain';
import { AppError } from '../../errors.js';
import { settings } from './configuration.js';
import { schedulerAwareContext } from '../approval/context.js';
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
 * 离职生效时（编排器步骤 4，L′ 为最终最后工作日）：按“离职生效时终止在途流程”配置撤回在途合同申请（DEC-725，取代 DEC-496①；
 * “离职后可签类型”豁免），起始日晚于 L′ 的合同软删除，有效且终止日为空或晚于 L′ 的合同原地终止。
 * termination 为离职适用的勾选；不传（退休，F-351 前）= 原口径，全部撤回。
 */
export async function handleContractsOnExit(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; lastWorkDate: string; termination?: ExitTerminationSetting | null },
): Promise<ExitContractOutcome> {
  await lockEmployee(tx, ctx, input.employeeId);
  await checkScope(tx, ctx, input.employeeId);
  const config = await settings(tx, ctx.tenantId);
  const withdrawnRequests = await cancelExitRequests(tx, ctx, input, config.postExitTypeIds);
  const records = await recordsOf(tx, ctx.tenantId, input.employeeId);
  const terminated: ExitContractOutcome['terminated'][number][] = [];
  const deleted: ExitContractOutcome['deleted'][number][] = [];
  for (const record of records) {
    const action = exitRecordAction(record, input, config.postExitTypeIds);
    if (!action) continue;
    const summary = {
      id: record.id,
      typeId: record.typeId,
      effectiveDate: record.effectiveDate,
      endDate: record.endDate,
    };
    if (action === 'delete') {
      await deleteContract(tx, ctx, record);
      deleted.push(summary);
    } else {
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

type ContractRequestRow = typeof contractRequests.$inferSelect;

/** DEC-725：勾选的合同流程一律撤回；未勾选的只撤回“终止日期”晚于 L 的（终止申请取实际终止日，其余取合同终止日，空 = 无固定期限）。 */
function withdrawnByExit(
  request: ContractRequestRow,
  input: { lastWorkDate: string; termination?: ExitTerminationSetting | null },
) {
  const flow = contractOperationFlow(request.operation);
  if (!input.termination || !flow) return true;
  const date = request.operation === 'terminate' ? request.actualTerminationDate : request.endDate;
  return terminatedByExit(input.termination, flow, date, input.lastWorkDate);
}

type ExitInput = { employeeId: string; lastWorkDate: string; termination?: ExitTerminationSetting | null };

/** 离职生效会撤回的在途合同申请：执行（cancelExitRequests）与离职预览（previewContractsOnExit）共用这一个判定。 */
function exitWithdrawsRequest(request: ContractRequestRow, input: ExitInput, postExitTypeIds: readonly string[]) {
  return (
    !postExitTypeIds.includes(request.typeId) &&
    ['approved', 'in_review', 'returned'].includes(request.status) &&
    withdrawnByExit(request, input)
  );
}

type ContractRecordRow = typeof contractRecords.$inferSelect;

/** 离职生效对一份合同的处置：起始日晚于 L′ 软删除，有效且终止日为空或晚于 L′ 的终止；离职后可签类型与已作废的合同不动。 */
function exitRecordAction(record: ContractRecordRow, input: ExitInput, postExitTypeIds: readonly string[]) {
  if (postExitTypeIds.includes(record.typeId) || record.status === 'void') return null;
  if (record.effectiveDate > input.lastWorkDate) return 'delete';
  if ((!record.endDate || record.endDate > input.lastWorkDate) && record.status === 'valid') return 'terminate';
  return null;
}

const requestsOf = (tx: Tx, tenantId: string, employeeId: string) =>
  tx
    .select()
    .from(contractRequests)
    .where(and(eq(contractRequests.tenantId, tenantId), eq(contractRequests.employeeId, employeeId)))
    .orderBy(contractRequests.id);

const recordsOf = (tx: Tx, tenantId: string, employeeId: string) =>
  tx
    .select()
    .from(contractRecords)
    .where(
      and(
        eq(contractRecords.tenantId, tenantId),
        eq(contractRecords.employeeId, employeeId),
        eq(contractRecords.deleted, false),
      ),
    )
    .orderBy(contractRecords.id);

/**
 * 离职预览（F-429 ②）：只读给出生效时将终止 / 删除的合同与将撤回的在途申请，选择与 handleContractsOnExit 逐项相同
 * （exitRecordAction / exitWithdrawsRequest）。不加锁、不查合同范围——查看人的合同对象查看权由离职预览按 §9.1 裁剪。
 */
export async function previewContractsOnExit(tx: Tx, tenantId: string, input: ExitInput) {
  const { postExitTypeIds } = await settings(tx, tenantId);
  const requests = (await requestsOf(tx, tenantId, input.employeeId)).filter((request) =>
    exitWithdrawsRequest(request, input, postExitTypeIds),
  );
  const records = await recordsOf(tx, tenantId, input.employeeId);
  const by = (action: 'delete' | 'terminate') =>
    records.filter((record) => exitRecordAction(record, input, postExitTypeIds) === action).map((record) => record.id);
  return {
    terminated: by('terminate'),
    deleted: by('delete'),
    withdrawnRequests: requests.map((request) => request.id),
  };
}

async function cancelExitRequests(
  tx: Tx,
  ctx: ContractContext,
  input: ExitInput,
  allowedTypes: string[],
): Promise<ExitContractOutcome['withdrawnRequests'][number][]> {
  const requests = await requestsOf(tx, ctx.tenantId, input.employeeId);
  const { activeInstanceOf, latestInstanceOf } = await import('../approval/store.js');
  const { cancel } = await import('../approval/actions.js');
  const approvalCtx = schedulerAwareContext(ctx);
  const withdrawn: ExitContractOutcome['withdrawnRequests'][number][] = [];
  for (const request of requests) {
    if (!exitWithdrawsRequest(request, input, allowedTypes)) continue;
    // 只取消活动实例；通知挂在最近相关的实例上（审批已通过的申请没有活动实例，发起人仍应收到消息）
    const active = await activeInstanceOf(tx, ctx.tenantId, 'contract', request.id);
    if (active) await cancel(tx, approvalCtx, active.id);
    const related = active ?? (await latestInstanceOf(tx, ctx.tenantId, 'contract', request.id));
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
      instanceId: related?.id ?? null,
      initiatorUserId: related?.initiatorUserId ?? request.createdBy,
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
