/** 联动选项的保存、修改、提交校验与查看（调动入口与 /transfers/:id/linkage 共用）。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { loadEmploymentBusiness } from '../../employment/read-model.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness, rowsOf } from '../../employment/record-store.js';
import { lockTransferParticipants } from '../../employment/transfer-locks.js';
import type { EmploymentContext } from '../../employment/types.js';
import { requireSavedBusiness } from '../../employment/write-service.js';
import { authorizeLinkageWrite, type LinkageAccess } from './access.js';
import { validateContractChange } from './contract.js';
import { applyTransferCrossLinkage, assertLinkageMutable, linkageExecuted } from './execute.js';
import { dutySubordinateIds, type LinkageOptions } from './input.js';
import { appendLinkageVersion, hasLinkage, latestLinkage } from './store.js';
import { validateLinkage } from './validation.js';

export interface LinkageTarget {
  readonly businessId: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly mode: 'direct' | 'application';
}

/**
 * 新建调动时保存联动（调用方已按 F-008 锁调动人与转交下属）。直接调动在保存当时已生效的，任职先落地、
 * 联动选项随后写入，因此在这里立即执行，与任职落地同一事务。
 */
export async function saveNewTransferLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  target: LinkageTarget,
  options: LinkageOptions | null,
  access?: LinkageAccess,
) {
  if (!hasLinkage(options)) return;
  await authorizeLinkageWrite(tx, ctx, access, {
    employeeId: target.employeeId,
    operation: 'create',
    options: options!,
  });
  await validateLinkage(tx, ctx, target.employeeId, options!);
  await appendLinkageVersion(tx, ctx, target, options!);
  if (target.mode === 'direct' && target.effectiveDate <= tenantLocalDate(ctx.now, ctx.timezone))
    await applyTransferCrossLinkage(tx, ctx, { id: target.businessId, ...target });
}

/** 修改联动：只限草稿 / 被驳回的申请与尚未生效的直接调动；校验业务 revision，成功后递增。 */
export async function updateTransferLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  options: LinkageOptions,
  access?: LinkageAccess,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const visible = await loadEmploymentBusiness(tx, ctx.tenantId, businessId, today, ctx.scope);
  if (!visible || visible.kind !== 'transfer') throw new AppError('NOT_FOUND', '调动不存在');
  await lockTransferParticipants(tx, ctx, visible.employeeId, dutySubordinateIds(options));
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  const [request] = rowsOf<{ initiator: string }>(
    await tx.execute(sql`SELECT initiator FROM transfer_requests
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`),
  );
  if (request?.initiator === 'employee')
    throw new AppError('VALIDATION_FAILED', '本人调动申请不能设置联动业务', { reason: 'TRANSFER_LINKAGE_NOT_ALLOWED' });
  const executed = await linkageExecuted(tx, ctx.tenantId, businessId);
  assertLinkageMutable(business.state, business.payload.mode, executed, business.payload.effectiveDate > today);
  await authorizeLinkageWrite(tx, ctx, access, { employeeId: business.employeeId, operation: 'update', options });
  await validateLinkage(tx, ctx, business.employeeId, options);
  await appendLinkageVersion(tx, ctx, { businessId, employeeId: business.employeeId }, options);
  await bumpEmploymentBusiness(tx, ctx, business);
  return requireSavedBusiness(tx, ctx, businessId);
}

/** DEC-183：提交时重查合同（保存后才出现的同类型在途合同同样 409）。 */
export async function assertTransferLinkageSubmittable(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const stored = await latestLinkage(tx, ctx.tenantId, businessId);
  if (!stored?.options.contract) return;
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId" FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
  );
  await validateContractChange(tx, ctx, owner!.employeeId, stored.options.contract);
}

/**
 * 供删除任职判断“有联动变更时阻止删除”（DEC-012，R1-T11）：合同已变更、职责已转交成功的子项。
 * 兼职结束同属已执行的联动，一并列出。
 */
export async function transferLinkageFootprint(tx: Tx, tenantId: string, businessId: string) {
  const [row] = rowsOf<{ contractId: string | null; duties: number; partTimes: number }>(
    await tx.execute(sql`SELECT r.after_contract_id AS "contractId",
      (SELECT count(*)::int FROM transfer_linkage_items i WHERE i.tenant_id=r.tenant_id AND i.business_id=r.business_id
        AND i.status='succeeded' AND i.item_type<>'part_time_end') AS duties,
      (SELECT count(*)::int FROM transfer_linkage_items i WHERE i.tenant_id=r.tenant_id AND i.business_id=r.business_id
        AND i.status='succeeded' AND i.item_type='part_time_end') AS "partTimes"
      FROM transfer_linkage_runs r WHERE r.tenant_id=${tenantId} AND r.business_id=${businessId}::uuid`),
  );
  return {
    changedContractId: row?.contractId ?? null,
    transferredDuties: Number(row?.duties ?? 0),
    endedPartTimes: Number(row?.partTimes ?? 0),
  };
}
