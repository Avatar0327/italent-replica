/** DEC-677：退休依赖与顺延均在原任职命令事务内维护，不新增调度器。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { pendingActivations, recordActivationAttempt } from './activation-store.js';
import { auditEmployment } from './context.js';
import { dayAfter } from './fields.js';
import { findPredecessor } from './read-model.js';
import { insertEmploymentRow, lockEmploymentBusiness, rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import { pendingRetirementId, rehireDependency, retireRehireActivationDecision } from './retire-rehire-eligibility.js';
import type { EmploymentContext } from './types.js';

/** 只在创建 / 人工修改 / 提交时选定依赖；自动恢复不得重新挑另一笔退休。 */
export async function bindRehireRetirement(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (business.payload.kind !== 'retire_rehire' || business.payload.mode !== 'application') return;
  const [candidate] = rowsOf<{ id: string | null }>(
    await tx.execute(sql`
    SELECT ${pendingRetirementId(ctx.tenantId, business.employeeId, business.payload.effectiveDate)}::text AS id`),
  );
  const previous = candidate?.id
    ? null
    : await findPredecessor(tx, ctx.tenantId, business.employeeId, business.payload.effectiveDate);
  const retirementId = candidate?.id ?? (previous?.kind === 'retirement' ? previous.id : null);
  if (!retirementId) return;
  const before = await rehireDependency(tx, ctx.tenantId, business.id);
  if (before?.retirementId === retirementId && !before.invalidated) return;
  await tx.execute(sql`INSERT INTO retire_rehire_dependencies (tenant_id,employee_id,business_id,retirement_id)
    VALUES (${ctx.tenantId},${business.employeeId}::uuid,${business.id}::uuid,${retirementId}::uuid)
    ON CONFLICT (tenant_id,business_id) DO UPDATE SET retirement_id=EXCLUDED.retirement_id, invalidated_at=NULL`);
  await auditEmployment(
    tx,
    ctx,
    'employment.retire_rehire.dependency',
    'employment-business',
    business.id,
    before ? { retirementBusinessId: before.retirementId, invalidated: before.invalidated } : null,
    { retirementBusinessId: retirementId, invalidated: false },
  );
}

/** 追加系统派生载荷，保留人工计划日；审批命令自行 bump，退休联动须 bump 目标业务的 revision。 */
async function shiftRehireDate(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  retirementId: string,
  retirementDate: string,
  bumpRevision: boolean,
) {
  const previous = business.payload;
  const date = dayAfter(retirementDate);
  if (previous.effectiveDate >= date) return;
  const next = {
    ...previous,
    id: randomUUID(),
    versionNo: previous.versionNo + 1,
    previousVersionId: previous.id,
    effectiveDate: date,
    triggerBusinessId: retirementId,
    commandId: ctx.commandId,
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  business.payload = next;
  if (bumpRevision)
    await tx.execute(sql`UPDATE employment_business_objects SET revision=revision+1
    WHERE tenant_id=${ctx.tenantId} AND id=${business.id}::uuid`);
  await auditEmployment(
    tx,
    ctx,
    'employment.retire_rehire.rescheduled',
    'employment-business',
    business.id,
    { effectiveDate: previous.effectiveDate },
    { effectiveDate: date, retirementBusinessId: retirementId, reason: 'RETIRE_REHIRE_AFTER_RETIREMENT' },
    next.id,
  );
}

/** 返聘迟到审批时，退休可能已经生效；在审批后的直接物化前按同一顺延规则校正日期。 */
export async function alignApprovedRehire(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  if (business.payload.kind !== 'retire_rehire') return;
  const dependency = await rehireDependency(tx, ctx.tenantId, business.id);
  if (dependency?.actualDate && !dependency.invalidated)
    await shiftRehireDate(tx, ctx, business, dependency.retirementId, dependency.actualDate, false);
}

/**
 * 退休状态事件的同事务联动：生效后为已批准返聘追加日期版本，交现有定时器到新日期落地；
 * 作废时先永久标记关联，再让已挂起的申请立即转失败。尚未到期的申请由到期判断消费同一标记。
 */
export async function retirementChanged(tx: Tx, ctx: EmploymentContext, retirement: LockedEmploymentBusiness) {
  if (retirement.payload.kind !== 'retirement') return;
  const effective = retirement.state === 'effective';
  if (!effective && !['draft', 'rejected', 'disapproved', 'voided', 'deleted'].includes(retirement.state)) return;
  const links = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT business_id::text AS id FROM retire_rehire_dependencies
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${retirement.employeeId}::uuid
      AND retirement_id=${retirement.id}::uuid AND invalidated_at IS NULL`),
  );
  if (!links.length) return;
  if (!effective) {
    await tx.execute(sql`UPDATE retire_rehire_dependencies SET invalidated_at=${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${retirement.employeeId}::uuid
        AND retirement_id=${retirement.id}::uuid AND invalidated_at IS NULL`);
    for (const { id } of links)
      await auditEmployment(
        tx,
        ctx,
        'employment.retire_rehire.dependency_voided',
        'employment-business',
        id,
        { retirementBusinessId: retirement.id, invalidated: false },
        { retirementBusinessId: retirement.id, invalidated: true },
      );
  }
  const linked = new Set(links.map((row) => row.id));
  for (const item of await pendingActivations(tx, ctx, retirement.employeeId)) {
    if (!linked.has(item.id)) continue;
    if (effective) {
      const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: item.revision }, item.id);
      await shiftRehireDate(tx, ctx, business, retirement.id, retirement.payload.effectiveDate, true);
    } else if (item.lastOutcome === 'suspended') {
      const decision = await retireRehireActivationDecision(tx, ctx, item);
      if (decision) await recordActivationAttempt(tx, ctx, item, { ...decision, trigger: 'retirement_change' });
    }
  }
}
