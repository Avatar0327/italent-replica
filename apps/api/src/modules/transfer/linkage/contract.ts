/**
 * 调动变更合同（`21` §2，REQ-LNK-001 R2）：本模块只负责何时调用合同端口，合同规则（CT-R10～R12：新版本、
 * 原合同作废 / 终止、编号、变动记录）全部由 R2-T06 的 changeContractForTransfer 在调用方事务内完成。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import { changeContractForTransfer } from '../../contracts/ports.js';
import type { ContractContext } from '../../contracts/context.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import type { LinkageOptions } from './input.js';

type ContractChange = NonNullable<LinkageOptions['contract']>;

interface TargetContract {
  readonly id: string;
  readonly employeeId: string;
  readonly typeId: string;
  readonly revision: number;
  readonly status: string;
  readonly approvalStatus: string;
}

async function loadTarget(tx: Tx, tenantId: string, employeeId: string, targetId: string) {
  const [row] = rowsOf<TargetContract>(
    await tx.execute(sql`
    SELECT id, employee_id AS "employeeId", type_id AS "typeId", revision, status, approval_status AS "approvalStatus"
    FROM contract_records WHERE tenant_id=${tenantId} AND id=${targetId}::uuid AND NOT deleted`),
  );
  // 他人的合同按不存在处理，不泄露存在性。
  if (!row || row.employeeId !== employeeId) throw new AppError('NOT_FOUND', '合同不存在');
  return { ...row, revision: Number(row.revision) };
}

/**
 * DEC-183 / DEC-180②：员工已有同类型在途的未来合同（审批中、被退回待重提或已批准未生效）时不能再经调动变更合同。
 * TODO(F-016)：F-016 落地 DEC-180② 后改用合同模块的在途判定，本函数只保留调用。
 */
async function assertNoInFlightContract(tx: Tx, ctx: EmploymentContext, employeeId: string, typeId: string) {
  const [pending] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT id FROM contract_requests
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND type_id=${typeId}::uuid
      AND operation<>'terminate' AND status IN ('in_review','returned','approved')
    ORDER BY effective_date, id LIMIT 1`),
  );
  if (pending)
    throw new AppError('CONFLICT', '员工有同类型在途的合同，请先处理在途合同后再变更合同', {
      reason: 'TRANSFER_CONTRACT_IN_FLIGHT',
      contractRequestId: pending.id,
    });
}

/** 保存 / 提交时：目标合同须属于该员工且当前有效；有同类型在途合同即 409（DEC-183）。 */
export async function validateContractChange(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  change: ContractChange,
): Promise<void> {
  const target = await loadTarget(tx, ctx.tenantId, employeeId, change.targetId);
  if (target.status !== 'valid' || target.approvalStatus !== 'effective')
    throw new AppError('CONFLICT', '只能变更当前有效的合同', { reason: 'TRANSFER_CONTRACT_NOT_VALID' });
  await assertNoInFlightContract(tx, ctx, employeeId, change.fields.typeId ?? target.typeId);
}

/**
 * 生效时在同一事务内调用合同端口。合同自保存后发生过实质变化（续签、编辑、终止）都会使目标不再有效而失败；
 * 端口的 revision 冲突同样转为可机读的业务失败，按 DEC-052 记 failed 交 HR 处理后重试，不在每次调度中空转。
 */
export async function changeContractOnActivation(
  tx: Tx,
  ctx: EmploymentContext,
  input: { readonly employeeId: string; readonly effectiveDate: string; readonly change: ContractChange },
): Promise<{ beforeContractId: string; afterContractId: string }> {
  const { employeeId, effectiveDate, change } = input;
  const target = await loadTarget(tx, ctx.tenantId, employeeId, change.targetId);
  await validateContractChange(tx, ctx, employeeId, change);
  // 保存时已按操作人的合同权限与范围校验（routes.ts）；生效端口只执行已授权的单据。
  const contractCtx: ContractContext = {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    timezone: ctx.timezone,
    now: ctx.now,
    commandId: ctx.commandId,
    expectedRevision: 0,
  };
  try {
    const result = await changeContractForTransfer(tx, contractCtx, {
      employeeId,
      targetId: target.id,
      revision: target.revision,
      fields: { ...change.fields, effectiveDate },
    });
    return { beforeContractId: target.id, afterContractId: result.id };
  } catch (error) {
    if (error instanceof AppError && error.code === 'REVISION_CONFLICT')
      throw new AppError('CONFLICT', '合同已变更，请核对后重试', { reason: 'TRANSFER_CONTRACT_CHANGED' });
    throw error;
  }
}
