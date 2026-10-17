/**
 * Offer 审批的发起入口（R2 BE-14a3，DEC-581；34 §2.1、OF-R15，DEC-532⑦、DEC-533④）：单个 Offer 发起审批、批量发起
 * （生成一张 Offer 批量审批单）。只负责发起与审批子状态；发起后对 Offer 状态机的其他影响（OF-R3 / R4）归 BE-14a2 / 14b。
 * 发起与审批中心同事务：先锁 Offer（批量按 ID 升序）、置“审批中”，再交审批引擎匹配流程、派首节点；首节点为空等
 * 拒绝时整单回滚（DEC-054），Offer 不变。审批结果由适配器（approval-adapter.ts）回写。
 */
import { offerBatchApprovalItems, offerBatchApprovals, pgErrorCode, sql, type Tx } from '@italent/db';
import { offerApprovable, tenantLocalDate, type OfferApprovalStatus, type OfferStatus } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ApprovalContext, FieldAccess } from '../approval/context.js';
import { rowsOf } from '../approval/context.js';
import { personOfUser } from '../approval/resolver.js';
import { findCurrentRecord } from '../employment/read-model.js';
import type { TenantRouteDeps } from '../../routes.js';
import { getModuleViewableFieldsInTransaction, scopeAllows } from '../permission/module-access.js';
import { assertOfferRevision, type OfferContext } from './context.js';
import type { OfferBatchInput } from './input.js';
import { lockOffer, offerDetail, saveApprovalStatus, type OfferRow } from './service.js';

const notApprovable = () =>
  new AppError('CONFLICT', '只有待发且未发起审批或审批不通过的 Offer 可以发起审批', {
    reason: 'OFFER_APPROVAL_NOT_ALLOWED',
  });

function requireApprovable(row: OfferRow) {
  const facts = { status: row.status as OfferStatus, approvalStatus: row.approvalStatus as OfferApprovalStatus };
  if (!offerApprovable(facts)) throw notApprovable();
}

/** 同人自动同意前按候选审批人的字段查看权做盲审（approval/routes.ts fieldAccess 同口径；Offer 没有嵌套对象字段）。 */
export const offerApprovalFields = (deps: TenantRouteDeps, ctx: OfferContext): FieldAccess => ({
  viewable: (tx, userId, objectCode) => getModuleViewableFieldsInTransaction(deps, { ...ctx, userId }, objectCode, tx),
});

const approvalContext = (ctx: OfferContext, fields: FieldAccess): ApprovalContext => ({
  ...ctx,
  expectedRevision: 0,
  fields,
});

/** 在途（审批中或驳回待重提）的审批实例。 */
async function activeInstances(tx: Tx, tenantId: string, businessType: string, ids: readonly string[]) {
  return rowsOf<{ id: string; business_id: string }>(
    await tx.execute(sql`SELECT id::text, business_id::text FROM approval_instances
      WHERE tenant_id = ${tenantId} AND business_type = ${businessType}
        AND business_id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND status IN ('running', 'returned')`),
  );
}

/** 单个 Offer 发起审批：驳回 / 撤回后再发起沿用原实例与原流程版本（DEC-103），由引擎判断。 */
export async function submitOfferApproval(tx: Tx, ctx: OfferContext, id: string, fields: FieldAccess) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  requireApprovable(before);
  await saveApprovalStatus(tx, ctx, before, 'approving');
  const { startOrResume } = await import('../approval/engine.js');
  await startOrResume(tx, approvalContext(ctx, fields), { businessType: 'offer', businessId: id });
  return offerDetail(tx, ctx, id);
}

/** 审批主体缺省取申请人主职部门（DEC-533④）：发起人绑定的人员在业务日期的主职任职部门。 */
async function applicantDepartment(tx: Tx, ctx: OfferContext): Promise<string | null> {
  const personId = await personOfUser(tx, ctx.tenantId, ctx.userId);
  if (!personId) return null;
  const record = await findCurrentRecord(tx, ctx.tenantId, personId, tenantLocalDate(ctx.now, ctx.timezone));
  return record?.fields.departmentId ?? null;
}

/** 显式指定的审批主体须在本人对 Offer 的组织范围内（范围外与不存在同为 400，不暴露存在性）。 */
async function subjectOrg(tx: Tx, ctx: OfferContext, input: OfferBatchInput): Promise<string> {
  const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });
  if (input.approvalSubjectOrgId) {
    if (!scopeAllows(ctx.scope, { orgId: input.approvalSubjectOrgId, creatorId: null }))
      throw invalid('OFFER_BATCH_SUBJECT_INVALID', '审批主体组织不存在或不在可操作范围内');
    return input.approvalSubjectOrgId;
  }
  const own = await applicantDepartment(tx, ctx);
  if (!own) throw invalid('OFFER_BATCH_SUBJECT_REQUIRED', '请选择审批主体组织');
  return own;
}

/**
 * 批量发起：子表 Offer 逐个核对范围（范围外与不存在同为 404）与可发起状态，有一个不满足整单拒绝（AGENTS §10「批量」）；
 * 被驳回待重提的单个 Offer 审批未了结前不能并入批量单（两张单不能同时管同一份 Offer）。
 */
export async function submitOfferBatch(tx: Tx, ctx: OfferContext, input: OfferBatchInput, fields: FieldAccess) {
  const rows: OfferRow[] = [];
  for (const id of [...input.offerIds].sort()) rows.push(await lockOffer(tx, ctx, id));
  rows.forEach(requireApprovable);
  if ((await activeInstances(tx, ctx.tenantId, 'offer', input.offerIds)).length) throw notApprovable();
  const approvalSubjectOrgId = await subjectOrg(tx, ctx, input);
  const batch = await tx
    .insert(offerBatchApprovals)
    .values({
      tenantId: ctx.tenantId,
      approvalSubjectOrgId,
      remark: input.remark ?? null,
      createdBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning()
    .catch((error: unknown) => {
      if (pgErrorCode(error) !== '23503') throw error;
      throw new AppError('VALIDATION_FAILED', '审批主体组织不存在或不在可操作范围内', {
        reason: 'OFFER_BATCH_SUBJECT_INVALID',
      });
    });
  const created = batch[0]!;
  await tx.insert(offerBatchApprovalItems).values(
    input.offerIds.map((offerId, index) => ({
      tenantId: ctx.tenantId,
      batchId: created.id,
      offerId,
      seq: index + 1,
    })),
  );
  const { auditBatch } = await import('./approval-adapter.js');
  await auditBatch(tx, ctx, 'create', null, { ...created, offerIds: input.offerIds });
  for (const row of rows) await saveApprovalStatus(tx, ctx, row, 'approving');
  const { startOrResume } = await import('../approval/engine.js');
  await startOrResume(tx, approvalContext(ctx, fields), { businessType: 'offer_batch', businessId: created.id });
  const items = [];
  for (const id of input.offerIds) items.push(await offerDetail(tx, ctx, id));
  return { id: created.id, revision: created.revision, items };
}

/** 删除 Offer 时作废它被驳回 / 撤回、待重新发起的单个审批实例（审批中的 Offer 不能删除，不会走到这里）。 */
export async function cancelOfferApproval(tx: Tx, ctx: OfferContext, id: string) {
  const [active] = await activeInstances(tx, ctx.tenantId, 'offer', [id]);
  if (!active) return;
  const { cancel } = await import('../approval/actions.js');
  await cancel(tx, { ...ctx, expectedRevision: 0 }, active.id);
}
