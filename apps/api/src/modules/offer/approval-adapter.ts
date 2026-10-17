/**
 * 审批中心的 Offer 适配器（R2 BE-14a3）：单个 Offer 审批（业务单 = Offer）与 Offer 批量审批（业务单 = 批量审批单，
 * 子表多份 Offer，参照集合审批“一单多对象”）。审批中心以可信身份回调，不带数据范围（DEC-057）。
 * - 快照：候选人不是员工，没有流程主体（subjectEmployeeId 为空、无多主体映射）；单个 Offer 的路由部门 = 录用部门，
 *   批量的路由部门 = 审批主体组织（resolver 的 offer_department_head / approval_subject_first_level_org_head 取它）；
 *   标题不含个人数据（DEC-057）；
 * - 结果回写 Offer 审批子状态：通过 → 审批通过、不同意 → 不通过、驳回 / 撤回 → 未发起审批（单个 Offer 修改后从 Offer
 *   重新发起沿用原实例，DEC-103；批量单作废，子表 Offer 可重新发起）。审批中编辑、审批侧重提不开放。
 * 取锁顺序：批量单 → Offer（按 ID 升序）→ 审批实例，与发起入口“Offer 升序 → 新批量单”不成环。
 */
import { and, asc, eq, offerBatchApprovalItems, offerBatchApprovals, offers, sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  effectiveOfferType,
  OFFER_APPROVAL_OUTCOMES,
  OFFER_BATCH_OBJECT,
  OFFER_BATCH_PROCESS_CODE,
  OFFER_OBJECT,
  type OfferType,
} from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import type { BusinessAdapter, BusinessSnapshot } from '../approval/adapters.js';
import { rowsOf, type ApprovalContext } from '../approval/context.js';
import { offerDto, saveApprovalStatus, type OfferRow } from './service.js';

type BatchRow = typeof offerBatchApprovals.$inferSelect;
type Outcome = keyof typeof OFFER_APPROVAL_OUTCOMES;

const unsupported = (message: string, reason: string) => () => {
  throw new AppError('CONFLICT', message, { reason });
};
const RESUBMIT = unsupported('请在 Offer 上修改后重新发起审批', 'APPROVAL_RESUBMIT_VIA_BUSINESS');
const EDIT = unsupported('Offer 审批不支持审批中编辑，请驳回后在 Offer 上修改', 'APPROVAL_EDIT_UNSUPPORTED');

async function offerRows(tx: Tx, tenantId: string, ids: readonly string[], lock = false) {
  if (!ids.length) return [];
  const query = tx
    .select()
    .from(offers)
    .where(sql`${offers.tenantId} = ${tenantId} AND ${offers.id} = ANY(${`{${ids.join(',')}}`}::uuid[])`)
    .orderBy(asc(offers.id));
  return lock ? query.for('update') : query;
}

/** 回写审批子状态：只改仍在审批中的 Offer（驳回后再撤回等重复回调不覆盖别处的新状态）。 */
async function settle(tx: Tx, ctx: ApprovalContext, rows: readonly OfferRow[], outcome: Outcome) {
  for (const row of rows)
    if (row.approvalStatus === 'approving') await saveApprovalStatus(tx, ctx, row, OFFER_APPROVAL_OUTCOMES[outcome]);
}

/** Offer 已删除（实例已作废）后审批记录仍可查：类型与标题取实例上的冻结值，表单为空。 */
async function deletedTitle(tx: Tx, ctx: ApprovalContext, id: string) {
  const [row] = rowsOf<{ title: string }>(
    await tx.execute(sql`SELECT title FROM approval_instances WHERE tenant_id = ${ctx.tenantId}
      AND business_type = 'offer' AND business_id = ${id}::uuid ORDER BY created_at DESC LIMIT 1`),
  );
  if (!row) throw new AppError('NOT_FOUND', 'Offer 不存在');
  return row.title;
}

const OFFER_FORM = APPROVAL_TYPES.offer.formFields;

async function offerSnapshot(tx: Tx, ctx: ApprovalContext, id: string): Promise<BusinessSnapshot> {
  const [row] = await offerRows(tx, ctx.tenantId, [id]);
  const dto = row ? offerDto(row) : {};
  const values = Object.fromEntries(OFFER_FORM.map((field) => [field, dto[field] ?? null]));
  return {
    approvalType: 'offer',
    businessType: 'offer',
    businessId: id,
    fieldObjectCode: OFFER_OBJECT,
    profileFields: [],
    subjectEmployeeId: null,
    title: row ? `${APPROVAL_TYPES.offer.name}申请` : await deletedTitle(tx, ctx, id),
    values,
    originals: null,
    // 新单据没有原值：有值的字段都是本单内容，审批人看不到即盲审（DEC-058）
    changedFields: OFFER_FORM.filter((field) => values[field] !== null),
    conditionValues: {
      processCode: APPROVAL_TYPES.offer.defaultProcessCode,
      'offer.offerType': effectiveOfferType(row?.offerType as OfferType | null),
      'offer.departmentId': row?.departmentId ?? null,
    },
    latestDepartmentId: null,
    recordDepartmentId: row?.departmentId ?? null,
    version: `revision:${row?.revision ?? 0}`,
    processCode: APPROVAL_TYPES.offer.defaultProcessCode,
  };
}

const lockOne = async (tx: Tx, ctx: ApprovalContext, id: string) => offerRows(tx, ctx.tenantId, [id], true);
const settleOne = (outcome: Outcome) => async (tx: Tx, ctx: ApprovalContext, id: string) =>
  settle(tx, ctx, await lockOne(tx, ctx, id), outcome);

export const offerAdapter: BusinessAdapter = {
  async lock(tx, ctx, id) {
    await lockOne(tx, ctx, id);
  },
  snapshot: offerSnapshot,
  approved: settleOne('approved'),
  disapproved: settleOne('disapproved'),
  rejected: settleOne('returned'),
  withdrawn: settleOne('returned'),
  resubmit: RESUBMIT,
  edit: EDIT,
};

// ---- Offer 批量审批 ----------------------------------------------------------------------------------------------

/** 批量单审计：归属审批主体组织，按 Offer 对象的当前组织范围查看（audit/visibility.ts）。 */
export async function auditBatch(
  tx: Tx,
  ctx: Pick<ApprovalContext, 'tenantId' | 'userId' | 'commandId' | 'now'>,
  action: string,
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> & Pick<BatchRow, 'id' | 'approvalSubjectOrgId'>,
) {
  await recordAudit(tx, {
    scope: { orgId: after.approvalSubjectOrgId },
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `offer_batch_approval.${action}`,
    objectType: 'offer_batch_approval',
    objectId: after.id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function loadBatch(tx: Tx, tenantId: string, id: string, lock = false) {
  const query = tx
    .select()
    .from(offerBatchApprovals)
    .where(and(eq(offerBatchApprovals.tenantId, tenantId), eq(offerBatchApprovals.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND', 'Offer 批量审批单不存在');
  const items = await tx
    .select({ offerId: offerBatchApprovalItems.offerId })
    .from(offerBatchApprovalItems)
    .where(and(eq(offerBatchApprovalItems.tenantId, tenantId), eq(offerBatchApprovalItems.batchId, id)))
    .orderBy(asc(offerBatchApprovalItems.seq));
  return { batch: row, offerIds: items.map((item) => item.offerId) };
}

/** 子表 7 列（OF-R15）：学校、学历 Offer 上没有对应字段，恒为空；基本工资取转正后工资。 */
const batchLine = (row: OfferRow) => ({
  offerId: row.id,
  name: row.name,
  school: null,
  education: null,
  plannedEntryDate: row.plannedEntryDate,
  departmentId: row.departmentId,
  positionId: row.positionId,
  baseSalary: row.salaryAfterRegular === null ? null : Number(row.salaryAfterRegular),
});

async function batchSnapshot(tx: Tx, ctx: ApprovalContext, id: string): Promise<BusinessSnapshot> {
  const { batch, offerIds } = await loadBatch(tx, ctx.tenantId, id);
  const rows = new Map((await offerRows(tx, ctx.tenantId, offerIds)).map((row) => [row.id, row]));
  const lines = offerIds.flatMap((offerId) => (rows.has(offerId) ? [rows.get(offerId)!] : []));
  const values = {
    approvalSubjectOrgId: batch.approvalSubjectOrgId,
    remark: batch.remark,
    offers: lines.map(batchLine),
  };
  return {
    approvalType: 'offer_batch',
    businessType: 'offer_batch',
    businessId: id,
    fieldObjectCode: OFFER_BATCH_OBJECT,
    profileFields: [],
    subjectEmployeeId: null,
    title: `${APPROVAL_TYPES.offer_batch.name}申请`,
    values,
    originals: null,
    changedFields: ['approvalSubjectOrgId', 'offers', ...(batch.remark ? ['remark'] : [])],
    conditionValues: {
      processCode: OFFER_BATCH_PROCESS_CODE,
      'batch.approvalSubjectOrgId': batch.approvalSubjectOrgId,
    },
    latestDepartmentId: null,
    recordDepartmentId: batch.approvalSubjectOrgId,
    // 子表 Offer 被绕过审批改动（如 BE-14a2 转移状态）时，旧审批一律 409（AGENTS §10「并发」）
    version: `revision:${batch.revision}:${lines.map((row) => row.revision).join(',')}`,
    processCode: OFFER_BATCH_PROCESS_CODE,
  };
}

const BATCH_STATUS: Readonly<Record<Outcome, string>> = {
  started: 'approving',
  approved: 'approved',
  disapproved: 'disapproved',
  returned: 'returned',
};

/**
 * 批量单办结：审批中的单据按结果改状态并回写子表 Offer；已作废（驳回后）的单据再被撤回只记撤回，不再动 Offer——
 * 它们可能已在别的单里审批。
 */
function settleBatch(outcome: Outcome, status = BATCH_STATUS[outcome]) {
  return async (tx: Tx, ctx: ApprovalContext, id: string) => {
    const { batch, offerIds } = await loadBatch(tx, ctx.tenantId, id, true);
    const active = batch.status === 'approving';
    const [after] = await tx
      .update(offerBatchApprovals)
      .set({ status, revision: batch.revision + 1, updatedAt: ctx.now })
      .where(and(eq(offerBatchApprovals.tenantId, ctx.tenantId), eq(offerBatchApprovals.id, id)))
      .returning();
    await auditBatch(tx, ctx, status, { status: batch.status }, after!);
    if (active) await settle(tx, ctx, await offerRows(tx, ctx.tenantId, offerIds, true), outcome);
  };
}

export const offerBatchAdapter: BusinessAdapter = {
  async lock(tx, ctx, id) {
    const { offerIds } = await loadBatch(tx, ctx.tenantId, id, true);
    await offerRows(tx, ctx.tenantId, offerIds, true);
  },
  snapshot: batchSnapshot,
  approved: settleBatch('approved'),
  disapproved: settleBatch('disapproved'),
  rejected: settleBatch('returned'),
  withdrawn: settleBatch('returned', 'withdrawn'),
  resubmit: unsupported('批量审批单被驳回或撤回后作废，请重新批量发起', 'APPROVAL_RESUBMIT_VIA_BUSINESS'),
  edit: EDIT,
};
