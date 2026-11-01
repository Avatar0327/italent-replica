/**
 * R2-T08 §7.1 数据量与排期（DEC-526③）：由审批通过事务调用（BE-10c 接入前只有内部调用方）。
 * 只写执行队列、涉及组织集合 S 与审计；不写暂停、不改组织与任职（§4.1 锁环论证）。
 */
import { orgAdjustmentExecutions, orgAdjustmentScopeOrgs, sql, type Tx } from '@italent/db';
import { addDays, tenantLocalDate } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { rowsOf } from '../approval/context.js';
import { countOrgEmploymentTargets } from '../org/employment-linkage.js';
import { groupScope, loadExecutionGroups, loadExecutionItems } from './execution-groups.js';

export const NEXT_DAY_VOLUME = 5000;
const NEXT_DAY_HOUR = 3;

export interface ScheduleContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
}

export async function scheduleOrgAdjustmentExecution(tx: Tx, ctx: ScheduleContext, adjustmentId: string) {
  const [head] = rowsOf<{ effective_date: string; approval_status: number; scheduled: boolean }>(
    await tx.execute(sql`SELECT a.effective_date::text, a.approval_status,
        EXISTS (SELECT 1 FROM org_adjustment_executions x
          WHERE x.tenant_id=a.tenant_id AND x.adjustment_id=a.id) AS scheduled
      FROM org_adjustments a WHERE a.tenant_id=${ctx.tenantId} AND a.id=${adjustmentId}::uuid FOR UPDATE`),
  );
  if (!head) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  if (head.approval_status !== 2 || head.scheduled)
    throw new AppError('CONFLICT', '组织调整不在可排期状态', { reason: 'ORG_ADJUSTMENT_NOT_SCHEDULABLE' });
  const date = head.effective_date;
  const items = await loadExecutionItems(tx, ctx.tenantId, adjustmentId);
  let dataVolume = items.length;
  for (const item of items)
    if (item.adjustType === 2 && item.addEmployment)
      dataVolume += await countOrgEmploymentTargets(tx, ctx.tenantId, item.targetOrgId!, date);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const late = dataVolume > NEXT_DAY_VOLUME;
  const run = { runOnDate: late ? addDays(today, 1) : today, runFromHour: late ? NEXT_DAY_HOUR : 0 };
  const keys = { tenantId: ctx.tenantId, adjustmentId };
  await tx.insert(orgAdjustmentExecutions).values({ ...keys, ...run });
  for (const group of await loadExecutionGroups(tx, ctx.tenantId, adjustmentId, date)) {
    const orgIds = await groupScope(tx, ctx.tenantId, group, items, date);
    if (orgIds.length)
      await tx
        .insert(orgAdjustmentScopeOrgs)
        .values(orgIds.map((orgId) => ({ ...keys, groupItemId: group.id, orgId })));
  }
  await tx.execute(sql`UPDATE org_adjustments SET data_volume=${dataVolume}, updated_at=${ctx.now.toISOString()}
    WHERE tenant_id=${ctx.tenantId} AND id=${adjustmentId}::uuid`);
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: 'org-adjustment.execution.scheduled',
    objectType: 'org-adjustment',
    objectId: adjustmentId,
    before: null,
    after: { dataVolume, ...run },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return { ...run, dataVolume };
}
