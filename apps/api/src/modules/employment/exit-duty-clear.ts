/**
 * 离职 / 退休落地时清空仍无接收人的职责（R2-T09b DT-R5，规格 `30`）：
 * 落地时仍承担、又不在转交计划里的职责一律清空——组织角色从生效日起写一个角色为空的组织新版本，下属的直线 / 虚线经理改为空
 * （都经职责转交的共享执行器 executeDutyItem，DEC-431① 单一入口，接收人为空 = 清空）；每条清空另写一条无接收人的未完成转交记录
 * （来源 2 离职 / 4 退休），菜单“检查离职退休人员”据此继续列出这个人，供 HR 事后补办。
 * 计划里的职责不在这里处理：成功的已转给接收人，失败的维持“失败可重试”（B-16），不被清空。
 * 重复调用幂等：落地只发生一次，清空后当日不再持有职责，第二次取不到。
 */
import { dutyTransferRecords, sql, type Tx } from '@italent/db';
import { DUTY_TRANSFER_SOURCE, DUTY_TRANSFER_STATUS } from '@italent/domain';
import { currentDuties, dutyKey, type Duty } from '../duty-transfer/duties.js';
import { plannedDutyKeys } from '../duty-transfer/uncovered.js';
import {
  dutyItemFailure,
  executeDutyItem,
  type DutyItem,
  type DutyItemFailure,
} from '../transfer/linkage/duty-execution.js';
import { latestLinkage } from '../transfer/linkage/store.js';
import { auditEmployment } from './context.js';
import { runExitDutyTransfer, type ExitTimingRow } from './exit-duty-transfer.js';
import type { EmploymentContext } from './types.js';

const toItem = (duty: Duty, effectiveDate: string): DutyItem =>
  duty.dutyType === 1
    ? {
        kind: 'org_role',
        employeeId: duty.holderId,
        orgId: duty.orgId!,
        orgRole: duty.orgRole as never,
        receiverId: null,
        effectiveDate,
      }
    : {
        kind: 'subordinate',
        employeeId: duty.holderId,
        subordinateId: duty.subordinateId!,
        relation: duty.relation as never,
        receiverId: null,
        effectiveDate,
      };

/** 落地时的职责收口：先按计划转交（生效时机的），再把计划之外仍无接收人的清空（DT-R5，顺序不可颠倒：已转出的不再持有）。 */
export async function settleExitDuties(
  tx: Tx,
  ctx: EmploymentContext,
  exit: ExitTimingRow,
  payloadKind: string,
  effectiveDate: string,
) {
  await runExitDutyTransfer(tx, ctx, exit, 'effective', effectiveDate);
  await clearUncoveredDuties(tx, ctx, exit, payloadKind, effectiveDate);
}

async function clearUncoveredDuties(
  tx: Tx,
  ctx: EmploymentContext,
  exit: { readonly businessId: string; readonly employeeId: string },
  payloadKind: string,
  effectiveDate: string,
): Promise<number> {
  const plan = (await latestLinkage(tx, ctx.tenantId, exit.businessId))?.options.dutyTransfer ?? null;
  const planned = plannedDutyKeys(plan);
  const left = (await currentDuties(tx, ctx.tenantId, exit.employeeId, effectiveDate)).filter(
    (duty) => !planned.has(dutyKey(duty)),
  );
  if (!left.length) return 0;
  await lockSubordinates(tx, ctx, left);
  const source = payloadKind === 'retirement' ? DUTY_TRANSFER_SOURCE.retirement : DUTY_TRANSFER_SOURCE.leave;
  const failures: string[] = [];
  for (const duty of left) {
    const failure = await attempt(tx, ctx, toItem(duty, effectiveDate));
    if (failure) failures.push(duty.key);
    await tx.insert(dutyTransferRecords).values({
      tenantId: ctx.tenantId,
      employeeId: exit.employeeId,
      receiverId: null,
      dutyType: duty.dutyType,
      orgId: duty.orgId,
      orgRole: duty.orgRole,
      subordinateId: duty.subordinateId,
      relation: duty.relation,
      dutyDetails: duty.description,
      status: DUTY_TRANSFER_STATUS.unfinished,
      transferDate: effectiveDate,
      batchId: exit.businessId,
      source,
      operatorId: null,
      attemptCount: 1,
      failureCode: failure?.code ?? null,
      failureMessage: failure?.message ?? null,
      failureRule: failure?.rule ?? null,
      lastAttemptAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  }
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.duty_cleared',
    'exit-request',
    exit.businessId,
    null,
    { effectiveDate, cleared: left.map((duty) => duty.key), failed: failures },
    undefined,
    undefined,
    { employeeId: exit.employeeId },
  );
  return left.length;
}

/** 被清空上级的下属按 UUID 升序一次取员工行锁（与其它入口同序，避免交叉等待）；组织角色之前先取。 */
async function lockSubordinates(tx: Tx, ctx: EmploymentContext, duties: readonly Duty[]) {
  const ids = [...new Set(duties.flatMap((duty) => (duty.subordinateId ? [duty.subordinateId] : [])))].sort();
  if (!ids.length) return;
  await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${ctx.tenantId}
    AND id=ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY id FOR NO KEY UPDATE`);
}

/**
 * 单条清空放在自己的保存点里：业务拒绝（如循环汇报、记录不可改）只记在这条转交记录的失败列上，离职照常落地，
 * 记录仍是“未完成”，HR 可事后补办；范围外 / 存储错误整体回滚上抛（与联动子项同一判定 dutyItemFailure）。
 */
async function attempt(tx: Tx, ctx: EmploymentContext, item: DutyItem): Promise<DutyItemFailure | null> {
  try {
    await tx.transaction((savepoint) => executeDutyItem(savepoint, ctx, item, { caller: 'linkage' }));
    return null;
  } catch (error) {
    const failure = dutyItemFailure(error);
    if (!failure) throw error;
    return failure;
  }
}
