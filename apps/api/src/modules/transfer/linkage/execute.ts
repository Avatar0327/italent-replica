/**
 * 调动生效时执行跨对象联动（REQ-LNK-001 R1：在生效时，不在审批通过时）。由 employment/transfer-linkage.ts 在
 * 任职落地的同一事务（定时生效时为同一保存点）内调用：
 * - 整单部分：合同变更、试岗、交接、待调薪提醒与子项登记。任一业务拒绝即随任职一起回滚，定时任务记 failed
 *   并按 DEC-112 挂起其后业务，HR 处理后重试（DEC-052 / DEC-183）；
 * - 子项部分（R3）：职责转交的每个下属 / 组织角色、每条兼职各在自己的保存点里执行，失败只记该子项，可单独重试。
 */
import {
  sql,
  transferHandovers,
  transferLinkageItems,
  transferLinkageRuns,
  transferOnTrials,
  type Tx,
} from '@italent/db';
import { addDays, tenantLocalDate, termEnd } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { auditEmployment } from '../../employment/context.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import { changeContractOnActivation } from './contract.js';
import { attemptLinkageItem, type LinkageItemRow } from './items.js';
import { dutyLines, latestLinkage, type StoredLinkage } from './store.js';

export interface ActivatedTransfer {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
}

export async function linkageExecuted(tx: Tx, tenantId: string, businessId: string): Promise<boolean> {
  const [run] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM transfer_linkage_runs
      WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`),
  );
  return !!run;
}

/**
 * DEC-186：定时调度延迟或失败后重试而晚于计划日执行时，联动按实际执行日（租户当日）对齐，原计划日记审计。
 * 审批晚于计划日即生效、补录过去日期的直接调动不属于迟到执行，仍按业务生效日。
 * TODO(F-017)：F-017 合并后任职记录本身也改到实际执行日，届时两者取同一日期，本函数保持一致即可。
 */
function executionDate(ctx: EmploymentContext, planned: string): string {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return ctx.scheduledActivation && today > planned ? today : planned;
}

/** 可重复执行：已有执行结果即返回（多实例、重试、审批即生效与直接调动共用同一入口）。 */
export async function applyTransferCrossLinkage(tx: Tx, ctx: EmploymentContext, transfer: ActivatedTransfer) {
  if (await linkageExecuted(tx, ctx.tenantId, transfer.id)) return;
  const stored = await latestLinkage(tx, ctx.tenantId, transfer.id);
  if (!stored) return;
  const plannedEffectiveDate = transfer.effectiveDate;
  transfer = { ...transfer, effectiveDate: executionDate(ctx, plannedEffectiveDate) };
  const { options } = stored;
  const contract = options.contract
    ? await changeContractOnActivation(tx, ctx, {
        employeeId: transfer.employeeId,
        effectiveDate: transfer.effectiveDate,
        change: options.contract,
      })
    : null;
  await tx.insert(transferLinkageRuns).values({
    tenantId: ctx.tenantId,
    businessId: transfer.id,
    employeeId: transfer.employeeId,
    versionId: stored.versionId,
    effectiveDate: transfer.effectiveDate,
    beforeContractId: contract?.beforeContractId ?? null,
    afterContractId: contract?.afterContractId ?? null,
    // DEC-002：薪酬不在首版，只生成“待调薪”提醒，不改薪资档案（`21` §3.4）。
    salaryReminderStatus: options.adjustSalary ? 'pending' : null,
    commandId: ctx.commandId,
    executedAt: ctx.now,
  });
  await recordTrialAndHandover(tx, ctx, transfer, stored);
  await auditEmployment(tx, ctx, 'transfer.linkage.executed', 'transfer-linkage', transfer.id, null, {
    plannedEffectiveDate,
    effectiveDate: transfer.effectiveDate,
    versionId: stored.versionId,
    contract,
  });
  if (options.adjustSalary)
    await auditEmployment(tx, ctx, 'transfer.linkage.salary_reminder', 'transfer-linkage', transfer.id, null, {
      title: '待调薪',
      effectiveDate: transfer.effectiveDate,
      audience: 'authorized-hr',
    });
  for (const item of await createItems(tx, ctx, transfer, stored)) await attemptLinkageItem(tx, ctx, item);
}

async function recordTrialAndHandover(
  tx: Tx,
  ctx: EmploymentContext,
  transfer: ActivatedTransfer,
  { options }: StoredLinkage,
) {
  if (options.onTrial) {
    // `29` PB-R23：开始日期缺省为调动生效日；预计结束日 = 开始日 + 期限（月）− 1 天。
    const startDate = options.onTrial.startDate ?? transfer.effectiveDate;
    await tx.insert(transferOnTrials).values({
      tenantId: ctx.tenantId,
      employeeId: transfer.employeeId,
      businessId: transfer.id,
      startDate,
      months: options.onTrial.months,
      expectedEndDate: termEnd(startDate, options.onTrial.months),
      status: 'in_trial',
      createdAt: ctx.now,
    });
  }
  if (options.handover)
    // `13` §6.2 / C-007：交接流程不在本任务，只登记交接人与“未发起”状态，供交接流程接入。
    await tx.insert(transferHandovers).values({
      tenantId: ctx.tenantId,
      employeeId: transfer.employeeId,
      businessId: transfer.id,
      handoverPersonId: options.handover.handoverPersonId,
      handoverStatus: 'not_started',
      approvalStatus: null,
      createdAt: ctx.now,
    });
}

async function createItems(
  tx: Tx,
  ctx: EmploymentContext,
  transfer: ActivatedTransfer,
  { options }: StoredLinkage,
): Promise<LinkageItemRow[]> {
  // TODO(需取证 #71)：结束兼职的失效日期口径（`21` AC-LNK-06 🟡）按“调动生效日 − 1 天”暂定。
  const partTimeEnd = addDays(transfer.effectiveDate, -1);
  const values = [
    ...dutyLines(options).map((line) => ({ ...line, partTimeRecordId: null, effectiveDate: transfer.effectiveDate })),
    ...options.partTimes.map((item) => ({
      itemType: 'part_time_end' as const,
      subordinateId: null,
      relation: null,
      orgId: null,
      orgRole: null,
      receiverId: null,
      partTimeRecordId: item.recordId,
      effectiveDate: partTimeEnd,
    })),
  ];
  if (!values.length) return [];
  return (await tx
    .insert(transferLinkageItems)
    .values(
      values.map((value, index) => ({
        ...value,
        tenantId: ctx.tenantId,
        employeeId: transfer.employeeId,
        businessId: transfer.id,
        lineNo: index + 1,
        status: 'pending',
        createdAt: ctx.now,
      })),
    )
    .returning()) as LinkageItemRow[];
}

/**
 * 联动选项只在审批前（草稿、被驳回）或直接调动生效前可改；审批中、已批准的内容以审批时为准，已执行的不再改。
 */
export function assertLinkageMutable(state: string, mode: string, executed: boolean, future: boolean) {
  const draft = mode === 'application' && ['draft', 'rejected'].includes(state);
  const pendingDirect = mode === 'direct' && state === 'effective' && !executed && future;
  if (!draft && !pendingDirect)
    throw new AppError('CONFLICT', '只有草稿、被驳回的申请或尚未生效的直接调动可以修改联动', {
      reason: 'LINKAGE_IMMUTABLE',
      state,
    });
}
