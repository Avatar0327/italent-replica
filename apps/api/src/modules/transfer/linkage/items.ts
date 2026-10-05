/**
 * 联动子项（REQ-LNK-001 R3，`21` AC-LNK-04）：每个子项在自己的保存点里执行，业务拒绝只记该子项失败（原因、次数），
 * 存储 / 依赖错误原样抛出由调用方整体回滚。范围外记录不是子项失败：按 DEC-178 整单拒绝（不吞成失败记录）。
 */
import { and, eq, sql, transferLinkageItems, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { assignTransferOrganizationPeople } from '../../org/write-service.js';
import { ruleRejection } from '../../employment/activation-checks.js';
import { auditEmployment, assertRevision } from '../../employment/context.js';
import { ineligibleOrgPeople } from '../../employment/org-people.js';
import { editEmploymentRecord } from '../../employment/record-edit.js';
import { findCurrentRecord } from '../../employment/read-model.js';
import { lockTransferParticipants } from '../../employment/transfer-locks.js';
import type { EmploymentContext } from '../../employment/types.js';
import type { DutyRelation, OrgRole } from './input.js';
import { transferPartTimePort } from './part-time.js';
import {
  RELATION_FIELDS,
  ROLE_FIELDS,
  requireLinkedRecordVisible,
  requireReportingSubordinate,
  requireRoleHolder,
} from './validation.js';

export type LinkageItemRow = typeof transferLinkageItems.$inferSelect;

export interface LinkageItemView {
  readonly id: string;
  readonly revision: number;
  readonly itemType: LinkageItemRow['itemType'];
  readonly subordinateId: string | null;
  readonly orgId: string | null;
  readonly orgRole: string | null;
  readonly relation: string | null;
  readonly receiverId: string | null;
  readonly partTimeRecordId: string | null;
  readonly effectiveDate: string;
  readonly status: LinkageItemRow['status'];
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly failure: { readonly code: string; readonly message: string; readonly rule: string | null } | null;
}

export function itemView(row: LinkageItemRow): LinkageItemView {
  return {
    id: row.id,
    revision: row.revision,
    itemType: row.itemType,
    subordinateId: row.subordinateId,
    orgId: row.orgId,
    orgRole: row.orgRole,
    relation: row.relation,
    receiverId: row.receiverId,
    partTimeRecordId: row.partTimeRecordId,
    effectiveDate: row.effectiveDate,
    status: row.status,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt ? new Date(row.lastAttemptAt).toISOString() : null,
    failure: row.failureCode
      ? { code: row.failureCode, message: row.failureMessage ?? '', rule: row.failureRule }
      : null,
  };
}

function itemFailure(error: unknown) {
  if (error instanceof AppError && error.code === 'LINKED_RECORD_OUT_OF_SCOPE') return null;
  const rejected = ruleRejection(error);
  if (!rejected) return null;
  const detail = rejected.detail as { code: string; message: string; rule?: unknown };
  return { code: detail.code, message: detail.message, rule: typeof detail.rule === 'string' ? detail.rule : null };
}

/** 执行一次并记结果；结果与审计、outbox 同事务（AGENTS.md §10）。 */
export async function attemptLinkageItem(tx: Tx, ctx: EmploymentContext, item: LinkageItemRow) {
  let failure: ReturnType<typeof itemFailure> = null;
  try {
    await tx.transaction((savepoint) => executeItem(savepoint, ctx, item));
  } catch (error) {
    failure = itemFailure(error);
    if (!failure) throw error;
  }
  const [saved] = await tx
    .update(transferLinkageItems)
    .set({
      status: failure ? 'failed' : 'succeeded',
      attemptCount: item.attemptCount + 1,
      failureCode: failure?.code ?? null,
      failureMessage: failure?.message ?? null,
      failureRule: failure?.rule ?? null,
      revision: item.revision + 1,
      lastAttemptAt: ctx.now,
    })
    .where(sql`tenant_id=${ctx.tenantId} AND id=${item.id}::uuid AND revision=${item.revision}`)
    .returning();
  if (!saved) throw new AppError('REVISION_CONFLICT', '联动子项已变更，请刷新后显式重提');
  // 失败事件即 HR 待办的通知来源（outbox 消费者推送给对该员工有权的 HR）。
  await auditEmployment(
    tx,
    ctx,
    `transfer.linkage.item.${saved.status}`,
    'transfer-linkage',
    item.businessId,
    { itemId: item.id, status: item.status, attemptCount: item.attemptCount },
    { itemId: item.id, itemType: item.itemType, status: saved.status, attemptCount: saved.attemptCount, failure },
  );
  return saved as LinkageItemRow;
}

async function executeItem(tx: Tx, ctx: EmploymentContext, item: LinkageItemRow) {
  if (item.itemType === 'part_time_end') {
    await transferPartTimePort().end(tx, ctx, {
      employeeId: item.employeeId,
      recordId: item.partTimeRecordId!,
      endDate: item.effectiveDate,
    });
    return;
  }
  // `30` DT-R6：接收人已离职等不再在职时报错。
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  if ((await ineligibleOrgPeople(tx, ctx.tenantId, [item.receiverId!], today)).length)
    throw new AppError('VALIDATION_FAILED', '接收人不是在职员工', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
  if (item.itemType === 'duty_org_role') {
    const role = item.orgRole as OrgRole;
    await requireRoleHolder(tx, ctx, item.employeeId, item.orgId!, role, item.effectiveDate);
    // DT-R7：业务内转交的组织变更记录取业务生效日。
    const people: Partial<Record<(typeof ROLE_FIELDS)[OrgRole], string>> = { [ROLE_FIELDS[role]]: item.receiverId! };
    await assignTransferOrganizationPeople(tx, ctx, item.orgId!, item.effectiveDate, people);
    return;
  }
  const relation = item.relation as DutyRelation;
  const record = await requireReportingSubordinate(tx, ctx, item.employeeId, item.subordinateId!, relation);
  // 与新增下属同一口径（`08` 附表 W-013）：原地改写下属当前任职的上级，不新增任职记录；汇报线循环在此报错。
  await editEmploymentRecord(
    tx,
    { ...ctx, expectedRevision: record.revision },
    record.id,
    { fields: { [RELATION_FIELDS[relation]]: item.receiverId! } },
    'api',
    { forwardUpdate: false },
  );
}

export async function loadLinkageItem(tx: Tx, tenantId: string, id: string, lock = false) {
  const query = tx
    .select()
    .from(transferLinkageItems)
    .where(and(eq(transferLinkageItems.tenantId, tenantId), eq(transferLinkageItems.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', '联动子项不存在');
  return row;
}

/**
 * HR 单独重试失败子项：F-008 先锁调动人与被改写的下属（员工 UUID 序），再锁子项行；revision 不一致 409，
 * 由客户端刷新后显式重提。操作人范围外的下属在执行前即整单拒绝（DEC-178）。
 */
export async function retryLinkageItem(tx: Tx, ctx: EmploymentContext, id: string): Promise<LinkageItemView> {
  const planned = await loadLinkageItem(tx, ctx.tenantId, id);
  await lockTransferParticipants(tx, ctx, planned.employeeId, planned.subordinateId ? [planned.subordinateId] : []);
  const item = await loadLinkageItem(tx, ctx.tenantId, id, true);
  assertRevision(ctx.expectedRevision, item.revision);
  if (item.status !== 'failed')
    throw new AppError('CONFLICT', '只有失败的联动子项可以重试', { reason: 'LINKAGE_ITEM_NOT_FAILED' });
  if (item.itemType === 'duty_subordinate') {
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const record = await findCurrentRecord(tx, ctx.tenantId, item.subordinateId!, today);
    if (record) await requireLinkedRecordVisible(tx, ctx, item.subordinateId!, record.fields.departmentId, record.id);
  }
  return itemView(await attemptLinkageItem(tx, ctx, item));
}
