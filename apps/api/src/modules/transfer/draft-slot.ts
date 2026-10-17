import { sql, type Tx } from '@italent/db';
import { employmentApprovalHooks } from '../employment/approval-hooks.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import { transitionEmployment } from '../employment/transitions.js';
import type { EmploymentContext } from '../employment/types.js';

/**
 * F-181a（DEC-511 / DEC-596）：他人调动申请的暂存单按（经办人 × 员工）一份。
 * 槽位 transfer_draft_slots 只指向暂存单；单据内容仍走任职业务的版本链，这里不复制。
 * 所有改槽位的入口都在员工行锁内（createTransfer / 清除命令都先锁员工），主键兜底并发。
 */
export interface TransferDraftMeta {
  readonly businessId: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly transferTypeCode: string;
  readonly reasonCode: string | null;
  readonly withEstablishment: boolean;
  readonly formId: string;
  readonly effectiveDate: string;
  readonly savedAt: string;
}

/** 只有“他人调动申请”的暂存占槽：直接调动不暂存，经理 / 本人入口不在本任务范围。 */
export const occupiesDraftSlot = (input: { initiator: string; mode: string }) =>
  input.initiator === 'hr' && input.mode === 'application';

/** 读调用人自己对该员工的暂存单元数据；槽位指向的单据已不是草稿（已提交 / 已删）视为没有。 */
export async function readTransferDraft(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
): Promise<TransferDraftMeta | null> {
  const [row] = rowsOf<TransferDraftMeta>(
    await tx.execute(sql`
    SELECT b.id AS "businessId", b.employee_id AS "employeeId", b.revision,
      r.transfer_type_code AS "transferTypeCode", r.reason_code AS "reasonCode",
      r.with_establishment AS "withEstablishment", p.form_id AS "formId",
      p.effective_date::text AS "effectiveDate", to_char(sl.updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "savedAt"
    FROM transfer_draft_slots sl
    JOIN employment_business_objects b
      ON b.tenant_id=sl.tenant_id AND b.employee_id=sl.employee_id AND b.id=sl.business_id
    JOIN transfer_requests r ON r.tenant_id=b.tenant_id AND r.business_id=b.id
    JOIN LATERAL (SELECT p.form_id, p.effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    WHERE sl.tenant_id=${ctx.tenantId} AND sl.user_id=${ctx.userId}::uuid AND sl.employee_id=${employeeId}::uuid
      AND s.state='draft'
  `),
  );
  return row ?? null;
}

/**
 * 释放调用人对该员工的暂存：暂存单仍是草稿就删除（任职业务删除内核，与 DELETE /businesses/:id 同一实现，留审计），
 * 槽位一并清掉。返回被删的暂存单号；没有可删的暂存返回 null。
 * expectedRevision 缺省时取当前版本（覆盖 / 提交时服务端自己换掉旧单）；清除命令传客户端的 If-Match，不符 409。
 */
export async function releaseTransferDraft(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  expectedRevision?: number,
): Promise<string | null> {
  await lockEmploymentEmployee(tx, ctx, employeeId);
  const [slot] = rowsOf<{ businessId: string; revision: number; state: string }>(
    await tx.execute(sql`
    SELECT sl.business_id AS "businessId", b.revision,
      (SELECT s.state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) AS state
    FROM transfer_draft_slots sl
    JOIN employment_business_objects b
      ON b.tenant_id=sl.tenant_id AND b.employee_id=sl.employee_id AND b.id=sl.business_id
    WHERE sl.tenant_id=${ctx.tenantId} AND sl.user_id=${ctx.userId}::uuid AND sl.employee_id=${employeeId}::uuid
    FOR UPDATE OF sl
  `),
  );
  if (!slot) return null;
  // 指针过期（单据已提交 / 已删）：只丢指针，不动单据
  if (slot.state === 'draft') {
    const context = { ...ctx, expectedRevision: expectedRevision ?? slot.revision };
    await transitionEmployment(tx, context, { id: slot.businessId, action: 'delete' });
    await employmentApprovalHooks.deleted(tx, context, slot.businessId);
  }
  await dropSlot(tx, ctx, employeeId);
  return slot.state === 'draft' ? slot.businessId : null;
}

/** 暂存成功后占槽（调用方已在员工行锁内、并已释放旧暂存）。 */
export async function holdTransferDraft(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO transfer_draft_slots(tenant_id, user_id, employee_id, business_id, created_at, updated_at)
    VALUES (${ctx.tenantId}, ${ctx.userId}::uuid, ${employeeId}::uuid, ${businessId}::uuid,
      ${ctx.now.toISOString()}::timestamptz, ${ctx.now.toISOString()}::timestamptz)
  `);
}

async function dropSlot(tx: Tx, ctx: EmploymentContext, employeeId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM transfer_draft_slots
    WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId}::uuid AND employee_id=${employeeId}::uuid
  `);
}
