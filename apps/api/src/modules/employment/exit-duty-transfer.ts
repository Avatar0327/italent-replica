/**
 * 离职职责转交（R2-T03 设计 §5.7，DEC-213；原 BE-9 并入 B3-2）：执行复用 transfer/linkage 的 applyDutyTransfer
 * （只建职责子项，每个子项自己的保存点，失败只记 duty_failed、可重试），这里按时机配置决定在哪个阶段调用并写离职台账：
 * business_effective → 离职落地（activateExit 步骤 6，生效日 = 最终生效日 E′）；
 * approval_passed → confirmed 阶段（审批通过 / 直接离职保存，生效日 = 当天）。同一离职至多执行一次（联动执行行幂等）。
 */
import { exitEffects, type Tx } from '@italent/db';
import { applyDutyTransfer } from '../transfer/linkage/execute.js';
import { auditEmployment } from './context.js';
import type { EmploymentContext } from './types.js';

/** 阶段与时机配置一一对应；配置的是另一个时机时本阶段什么也不做。 */
const TIMING_OF = { confirmed: 'approval_passed', effective: 'business_effective' } as const;

export async function runExitDutyTransfer(
  tx: Tx,
  ctx: EmploymentContext,
  exit: { readonly businessId: string; readonly employeeId: string; readonly dutyTransferTiming: string },
  phase: keyof typeof TIMING_OF,
  effectiveDate: string,
) {
  if (exit.dutyTransferTiming !== TIMING_OF[phase]) return;
  const items = await applyDutyTransfer(tx, ctx, {
    businessId: exit.businessId,
    employeeId: exit.employeeId,
    effectiveDate,
  });
  if (!items.length) return;
  await tx.insert(exitEffects).values(
    items.map((item) => ({
      tenantId: ctx.tenantId,
      businessId: exit.businessId,
      employeeId: exit.employeeId,
      phase,
      kind: item.status === 'succeeded' ? 'duty_transferred' : 'duty_failed',
      targetType: 'transfer-linkage-item',
      targetId: item.id,
      detail: {
        itemType: item.itemType,
        subordinateId: item.subordinateId,
        orgId: item.orgId,
        orgRole: item.orgRole,
        receiverId: item.receiverId,
        effectiveDate,
        failureCode: item.failureCode,
        failureRule: item.failureRule,
      },
      commandId: ctx.commandId,
      createdAt: ctx.now,
    })),
  );
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.duty_transfer',
    'exit-request',
    exit.businessId,
    null,
    {
      phase,
      effectiveDate,
      transferred: items.filter((item) => item.status === 'succeeded').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
    undefined,
    undefined,
    { employeeId: exit.employeeId },
  );
}
