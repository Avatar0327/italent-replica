import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { assignTransferOrganizationPeople } from '../org/write-service.js';
import { auditEmployment, requireScopedEmploymentObject } from './context.js';
import { ineligibleOrgPeople } from './org-people.js';
import { editEmploymentRecord } from './record-edit.js';
import { findCurrentRecord, loadEmploymentRecord } from './read-model.js';
import { lockEmploymentBusiness, rowsOf } from './record-store.js';
import { appendForwardPayload, auditForwardTarget } from './forward-store.js';
import type { BusinessKind, EmploymentContext, EmploymentRecord, PresetFields } from './types.js';

export function hasTransferLinkage(fields: PresetFields): boolean {
  return fields.isDepartmentHead === true || fields.isStoreManager === true || !!fields.addedSubordinateIds?.length;
}

/** 保存与生效都检查人员；保存时按当前操作者范围校验，审批/定时端口只执行已授权的单据。 */
export async function validateTransferSubordinates(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  fields: PresetFields,
  asOf: string,
) {
  const ids = fields.addedSubordinateIds ?? [];
  if (!ids.length) return;
  if (ids.includes(employeeId) || (await ineligibleOrgPeople(tx, ctx.tenantId, ids, asOf)).length)
    throw new AppError('VALIDATION_FAILED', '新增下属须为本租户在职员工且不能为本人', {
      reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
    });
  for (const id of ids) {
    const record = await findCurrentRecord(tx, ctx.tenantId, id, asOf);
    if (!record) throw new AppError('VALIDATION_FAILED', '新增下属没有当前任职');
    await requireScopedEmploymentObject(tx, ctx, id, record.fields.departmentId, record.id);
  }
}

/** 仅生效时执行。任职、组织版本、下属快照、审计与 outbox 全在调用者同一事务。
 * 08 §12：新增下属不新增业务记录；编辑当前任职追加不可变快照，不覆盖历史底表。
 */
export async function applyTransferLinkage(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, businessId, today);
  if (!record || record.kind !== 'transfer' || record.effectiveDate > today) return;
  const [done] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_outbox
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid
      AND event_type='employment.transfer.linked' LIMIT 1`),
  );
  if (done) return;
  const { fields, employeeId, effectiveDate } = record;
  await validateTransferSubordinates(tx, ctx, employeeId, fields, today);
  if (fields.isDepartmentHead || fields.isStoreManager) {
    if (!fields.departmentId) throw new AppError('VALIDATION_FAILED', '新部门不能为空');
    await assignTransferOrganizationPeople(tx, ctx, fields.departmentId, effectiveDate, {
      ...(fields.isDepartmentHead ? { personInChargeId: employeeId } : {}),
      ...(fields.isStoreManager ? { shopOwnerId: employeeId } : {}),
    });
  }
  for (const id of [...(fields.addedSubordinateIds ?? [])].sort()) {
    const current = await findCurrentRecord(tx, ctx.tenantId, id, today);
    if (!current) throw new AppError('VALIDATION_FAILED', '新增下属没有当前任职');
    await editEmploymentRecord(
      tx,
      { ...ctx, expectedRevision: current.revision },
      current.id,
      { fields: { directManagerId: employeeId } },
      'api',
      { forwardUpdate: false },
    );
  }
  if (fields.isDepartmentHead) await propagateDepartmentHead(tx, ctx, record);
  await auditEmployment(tx, ctx, 'employment.transfer.linked', 'employment-business', businessId, null, {
    departmentId: fields.departmentId,
    isDepartmentHead: fields.isDepartmentHead,
    isStoreManager: fields.isStoreManager,
    addedSubordinateIds: fields.addedSubordinateIds,
    effectiveDate,
  });
}

/** W-013：保存时不向后传播负责人标志；生效后才补写同一周期、同一部门的后续任职。 */
async function propagateDepartmentHead(tx: Tx, ctx: EmploymentContext, source: EmploymentRecord) {
  const targets = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT t.record_id AS id FROM employment_timeline t
    JOIN employment_timeline origin ON origin.tenant_id=t.tenant_id AND origin.record_id=${source.id}::uuid
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${source.employeeId}::uuid
      AND t.staff_id=${source.staffId}::uuid
      AND t.start_date>${tenantLocalDate(ctx.now, ctx.timezone)}::date
      AND (t.start_date,t.sort_order)>(origin.start_date,origin.sort_order)
    ORDER BY t.start_date,t.sort_order LIMIT 1001
  `),
  );
  if (targets.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '后续任职超过处理上限');
  for (const target of targets) {
    const record = await loadEmploymentRecord(tx, ctx.tenantId, target.id, source.effectiveDate);
    if (!record || record.fields.departmentId !== source.fields.departmentId || record.fields.isDepartmentHead === true)
      continue;
    await requireScopedEmploymentObject(tx, ctx, record.employeeId, record.fields.departmentId, record.id);
    const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: record.revision }, record.id);
    const changes = [{ field: 'isDepartmentHead', before: record.fields.isDepartmentHead, after: true }];
    const next = await appendForwardPayload(
      tx,
      ctx,
      business.payload,
      { fields: { ...record.fields, isDepartmentHead: true }, customFields: record.customFields },
      source.id,
      true,
      changes,
    );
    await auditForwardTarget(tx, ctx, next, changes);
  }
}

export async function queueTransferLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  kind: BusinessKind,
  fields: PresetFields,
  effectiveDate: string,
) {
  if (kind !== 'transfer') return;
  // DEC-173：无联动的未来直接调动也必须到期复查。与联动标记分开，失败只提醒。
  if (effectiveDate > tenantLocalDate(ctx.now, ctx.timezone)) {
    const [queued] = rowsOf(
      await tx.execute(sql`SELECT 1 FROM employment_outbox
      WHERE tenant_id=${ctx.tenantId} AND business_id=${id}::uuid
        AND event_type='employment.transfer.recheck.pending' LIMIT 1`),
    );
    if (!queued)
      await auditEmployment(tx, ctx, 'employment.transfer.recheck.pending', 'employment-business', id, null, {
        effectiveDate,
      });
  }
  if (!hasTransferLinkage(fields)) return;
  const [pending] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_outbox
    WHERE tenant_id=${ctx.tenantId} AND business_id=${id}::uuid
      AND event_type='employment.transfer.linkage.pending' LIMIT 1`),
  );
  if (!pending)
    await auditEmployment(tx, ctx, 'employment.transfer.linkage.pending', 'employment-business', id, null, {
      effectiveDate,
    });
  await applyTransferLinkage(tx, ctx, id);
}
