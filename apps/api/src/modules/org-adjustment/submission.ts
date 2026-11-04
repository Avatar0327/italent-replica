/**
 * 组织调整的提交 / 撤回与审批结果回写（R2-T08 §3 状态机、§4.1～4.4、§14.1，BE-10c）。
 * - 提交（路由 10）与审批中心重提：整单关口（whole-check，与审批中编辑、同意前同一入口）——非暂存行（含连带行）
 *   基线过期 → 409 `ORG_ADJUSTMENT_BASELINE_CHANGED` 并列出行；整单校验（与路由 7 同一份判断）有问题 → 400；
 *   通过后 0 / 6 → 1、revision + 1、审计，同事务交审批引擎（驳回 / 撤回后沿用原实例，DEC-103）。
 * - 撤回（路由 11）只限申请人本人，1 → 0；在途实例同事务撤回（业务侧已迁移状态，不再回调适配器）。
 * - 审批结果：通过 → 2（执行状态保持 1 未执行，BE-10c 不写执行队列）、驳回 → 6、不同意 → 3、审批侧撤回 → 0。
 * 锁序：申请单行 FOR UPDATE → 审批实例（引擎 openRun 经适配器 lock 再锁实例），不取组织锁（DEC-196）。
 */
import { sql, type Tx } from '@italent/db';
import { ORG_ADJUSTMENT_APPROVAL_STATUS as STATUS } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { ApprovalContext, FieldAccess } from '../approval/context.js';
import {
  authorizeItemFieldWrites,
  authorizeOwnerAction,
  authorizeWithdraw,
  HEAD_BUTTONS,
  orgScopeAuthorizer,
} from './access.js';
import { writtenItemFieldCodes } from './item-validation.js';
import { trimmedForViewer } from './envelope.js';
import { loadWorld } from './item-tree.js';
import { loadItems, loadItemTrail, type OrgItem } from './items-store.js';
import { audit, editable, loadAdjustment, type AdjustmentView, type WriteContext } from './service.js';
import { assertWhole } from './whole-check.js';

const NOT_FOUND = '组织调整申请不存在';
const BUSINESS = { businessType: 'org_adjustment' } as const;

/** 提交关口（提交 / 重提共用）：整单关口按库里的头与明细（whole-check）。暂存行不判基线、除被引用外不报问题。 */
async function assertSubmittable(tx: Tx, ctx: WriteContext, view: AdjustmentView) {
  await assertWhole(tx, await loadWorld(tx, ctx.tenantId, view), ctx.now);
}

/**
 * 锁住的申请单置新审批状态：revision + 1、同事务审计（系统身份的回调操作人记空）。
 * 审批通过同时写 approved_at：执行队列按 (approved_at, id) 排序，相交单的先后守卫靠它（§7.3，F-463）。
 */
async function setStatus(tx: Tx, ctx: WriteContext, before: AdjustmentView, status: number, action: string) {
  const approvedAt = status === STATUS.approved ? ctx.now.toISOString() : null;
  await tx.execute(sql`UPDATE org_adjustments SET approval_status = ${status}, revision = revision + 1,
      updated_at = ${ctx.now.toISOString()}, approved_at = COALESCE(${approvedAt}::timestamptz, approved_at)
    WHERE tenant_id = ${ctx.tenantId} AND id = ${before.id}`);
  const view = (await loadAdjustment(tx, ctx.tenantId, before.id))!;
  await audit(tx, ctx, `org-adjustment.${action}`, before, view);
  return view;
}

/** 路由 10：0 / 6 → 1，交审批引擎（首节点为空等拒绝时整笔回滚，DEC-054）。 */
export async function submitAdjustment(tx: Tx, ctx: WriteContext, id: string, fields: FieldAccess) {
  const before = await editable(tx, ctx, id);
  await assertSubmittable(tx, ctx, before);
  const view = await setStatus(tx, ctx, before, STATUS.reviewing, 'submit');
  const { startOrResume } = await import('../approval/engine.js');
  await startOrResume(tx, { ...ctx, expectedRevision: 0, fields }, { ...BUSINESS, businessId: id });
  return view;
}

/** 路由 11：申请人本人撤回审批中的单据 → 0；在途实例同事务撤回（仍校验发起人与节点是否允许撤回）。 */
export async function withdrawAdjustment(tx: Tx, ctx: WriteContext, id: string, fields: FieldAccess) {
  const before = await loadAdjustment(tx, ctx.tenantId, id, true);
  if (!before) throw new AppError('NOT_FOUND', NOT_FOUND);
  if (before.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '申请单已被修改，请刷新后重试');
  if (before.createdBy !== ctx.userId) {
    throw new AppError('FORBIDDEN', '只有申请人可以撤回申请单', { reason: 'ORG_ADJUSTMENT_NOT_APPLICANT' });
  }
  if (before.approvalStatus !== STATUS.reviewing) {
    throw new AppError('CONFLICT', '申请单不在审批中，不能撤回', { reason: 'ORG_ADJUSTMENT_NOT_IN_REVIEW' });
  }
  const view = await setStatus(tx, ctx, before, STATUS.staged, 'withdraw');
  const { activeInstanceOf } = await import('../approval/store.js');
  const active = await activeInstanceOf(tx, ctx.tenantId, BUSINESS.businessType, id);
  if (active?.status === 'running') {
    const { withdraw } = await import('../approval/actions.js');
    await withdraw(tx, { ...ctx, expectedRevision: active.revision, fields }, active.id, true);
  }
  return view;
}

/** 作废已驳回单时结束退回中的实例（§3：作废后不可再改、再提交）。 */
export async function cancelReturned(tx: Tx, ctx: WriteContext, id: string) {
  const { activeInstanceOf } = await import('../approval/store.js');
  const active = await activeInstanceOf(tx, ctx.tenantId, BUSINESS.businessType, id);
  if (active?.status !== 'returned') return;
  const { cancel } = await import('../approval/actions.js');
  await cancel(tx, { ...ctx, expectedRevision: active.revision }, active.id);
}

async function lockStored(tx: Tx, ctx: WriteContext, id: string) {
  const row = await loadAdjustment(tx, ctx.tenantId, id, true);
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
  return row;
}

/** 审批侧重提（openOwn 已判发起人与实例 revision）：只接受已驳回单，按提交口径重判后 → 1；不带修正。 */
export async function resubmitFromApproval(tx: Tx, ctx: ApprovalContext, id: string, corrections: object) {
  // 校验类错误按重提人的字段查看权裁剪（与路由 10 同口径，F-427）
  await trimmedForViewer(tx, ctx, () => resubmit(tx, ctx, id, corrections));
}

async function resubmit(tx: Tx, ctx: ApprovalContext, id: string, corrections: object) {
  if (Object.keys(corrections).length > 0) {
    throw new AppError('VALIDATION_FAILED', '组织调整重提不带修正，请在申请单上修改后提交', {
      reason: 'ORG_ADJUSTMENT_CORRECTIONS_UNSUPPORTED',
    });
  }
  const before = await lockStored(tx, ctx, id);
  if (before.approvalStatus !== STATUS.rejected) {
    throw new AppError('CONFLICT', '申请单当前状态不能重新提交', { reason: 'ORG_ADJUSTMENT_NOT_EDITABLE' });
  }
  await assertSubmittable(tx, ctx, before);
  await setStatus(tx, ctx, before, STATUS.reviewing, 'resubmit');
}

/** 审批结果回写：只改仍在审批中的单据（重复回调不覆盖别处的新状态）；返回本次是否回写（通过后据此入队）。 */
export async function settleApproval(tx: Tx, ctx: ApprovalContext, id: string, status: number, action: string) {
  const before = await lockStored(tx, ctx, id);
  if (before.approvalStatus !== STATUS.reviewing) return false;
  await setStatus(tx, ctx, before, status, action);
  return true;
}

export function settleFromApproval(status: number, action: string) {
  return async (tx: Tx, ctx: ApprovalContext, id: string) => {
    await settleApproval(tx, ctx, id, status, action);
  };
}

/** 明细行涉及的已有组织（目标、新上级、转移目标），去空去重。 */
export function rowOrgIds(rows: readonly OrgItem[]): string[] {
  const ids = rows.flatMap((row) => [row.targetOrgId, row.parentOrgId, row.transferToOrgId]);
  return [...new Set(ids.filter((orgId): orgId is string => Boolean(orgId)))];
}

interface OwnerDeps {
  readonly authorize: Authorizer;
  readonly clock: () => Date;
}

/**
 * 提交口径的授权（路由 10、审批中心重提）：主对象 update + `EditAdjustOrgDetailBtn@detail` + 主体组织与调整范围，
 * 明细行用户写过的 `orgItems.*` 字段写权，含写过又清空的（F-428），全部明细（含暂存行）涉及的组织按新建口径逐个在组织对象范围（§6.3，before = null）。
 */
export async function authorizeSubmission(tx: Tx, deps: OwnerDeps, ctx: TenantContext, stored: AdjustmentView) {
  const head = { subjectOrgId: stored.approvalSubjectOrgId, rangeOrgIds: stored.adjustmentRange };
  await authorizeOwnerAction(tx, deps, ctx, { ...head, button: HEAD_BUTTONS.update });
  const items = await loadItems(tx, ctx.tenantId, stored.id);
  const trail = await loadItemTrail(tx, ctx.tenantId, items);
  await authorizeItemFieldWrites(tx, deps, ctx, writtenItemFieldCodes(items, trail));
  await orgScopeAuthorizer(deps, ctx)(tx, rowOrgIds(items));
}

/** 撤回口径（路由 11、审批中心撤回）：没有按钮，主对象 update + 主体组织与调整范围（同路由 1）。 */
export async function authorizeWithdrawal(tx: Tx, deps: OwnerDeps, ctx: TenantContext, stored: AdjustmentView) {
  const head = { subjectOrgId: stored.approvalSubjectOrgId, rangeOrgIds: stored.adjustmentRange };
  await authorizeWithdraw(tx, deps, ctx, head);
}

/**
 * 审批中心撤回 / 重提的事务内复核（approval/access.ts 的命令守卫调用，首次与重放都经过）：锁申请单（锁序先于实例），
 * 不存在 → 404，再按撤回 / 提交口径判当前权限。
 */
export async function authorizeOwnerOf(
  tx: Tx,
  deps: OwnerDeps,
  ctx: TenantContext,
  adjustmentId: string,
  mode: 'withdraw' | 'resubmit',
) {
  const stored = await loadAdjustment(tx, ctx.tenantId, adjustmentId, true);
  if (!stored) throw new AppError('NOT_FOUND', NOT_FOUND);
  await (mode === 'withdraw' ? authorizeWithdrawal : authorizeSubmission)(tx, deps, ctx, stored);
}
