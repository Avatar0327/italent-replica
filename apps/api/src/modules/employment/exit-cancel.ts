/**
 * 撤销离职 / 退休（R2-T03 设计 §7.1，DM-R5 / R6，DEC-222；批 B4；退休 R2-T04 §6，批 5a′ 同一个 cancelExit、只把写死离职的点参数化）：
 * 四种情况共用一个入口 cancelExit，状态迁移走 transitionEmployment
 * （revoke / delete，唯一的状态机与时间轴写入处），本文件负责：情况判定、全局锁序（员工 / 业务 → 组织 → 编制 → 审批实例）、
 * §6B 区间变化统一校验（approved / effective 两种情况各一次，函数同一个）、撤销记录 exit_cancellations、撤销清单（下游探针）、审计与撤销端口。
 * “不删历史”：版本、状态事件、exit_requests、exit_effects、命令台账全部保留，只追加 voided / deleted 事件 + 墓碑 + 撤销记录。
 * 导出签名（cancelExit / updateCancellationReason / exitCancelCase）保持稳定：F-140、BE-8、兼职 PT6b 只通过探针端口与撤销端口接入。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, exitCancellations, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { lockEstablishment } from '../establishment/store.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import { auditEmployment } from './context.js';
import { loadOccupancy, assertOccupancyChange } from './exit-cancel-intervals.js';
import { runExitCancelledHooks, type ExitCancelCase } from './exit-confirmation.js';
// 撤销离职回收黑名单（BE-8b1，DEC-631）订阅 onCancelled 端口，随撤销入口一起加载
import './exit-blacklist.js';
import { probeDownstream, type Downstream } from './exit-downstream.js';
import { businessKind, isExitKind, loadExitRequest } from './exit-gate.js';
import { lockExitOrganizationResources } from './exit-void-applications.js';
import './retirement-cancel-hook.js';
import { lockEmploymentBusiness, rowsOf } from './record-store.js';
import { transitionEmployment } from './transitions.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { BusinessKind, EmploymentBusiness, EmploymentContext } from './types.js';

export interface CancelInput {
  /** 撤销离职原因（必填，原站弹窗唯一必填项，T-402e / W-108）。 */
  readonly reason: string;
  /** DEC-258：超编确认。 */
  readonly confirmed?: boolean;
}

export interface CancellationRecord {
  readonly id: string;
  readonly case: ExitCancelCase;
  readonly stateBefore: string;
  readonly reason: string;
  readonly revision: number;
  readonly createdAt: string;
}

/** 回执：业务头 + 撤销记录 + 未按查看人裁剪的清单（响应前由路由按查看人裁剪）。 */
export type CancelReceipt = EmploymentBusiness & {
  readonly cancellation: CancellationRecord;
  readonly downstream: Downstream;
};

const CANCELLABLE = ['draft', 'in_review', 'rejected', 'approved', 'effective'] as const;
export const isCancellableState = (state: string) => (CANCELLABLE as readonly string[]).includes(state);

/**
 * 撤销四种情况（设计 §7.1）：未办结（草稿 / 审批中 / 已驳回）= process_voided；审批通过未生效 = approved_voided；
 * 已生效且今天 ≤ L′ = record_deleted；已生效且今天 > L′ = record_deleted_reinstated（离职只在 E′ ≤ 今天时落地，后一种是实际会出现的）。
 */
export function exitCancelCase(state: string, today: string, lastWorkDate: string | null): ExitCancelCase {
  if (state === 'approved') return 'approved_voided';
  if (state === 'effective')
    return lastWorkDate && today <= lastWorkDate ? 'record_deleted' : 'record_deleted_reinstated';
  if (['draft', 'in_review', 'rejected'].includes(state)) return 'process_voided';
  throw new AppError('CONFLICT', '当前状态不能撤销离职', { reason: 'EXIT_NOT_CANCELLABLE', state });
}

/** 文案按业务类型取名（退休 R2-T04 §6）；原因码、状态码两种业务共用。 */
export const exitKindLabel = (kind: string) => (kind === 'retirement' ? '退休' : '离职');

const textReason = (value: string, kind: string) => {
  const reason = value.trim();
  if (!reason)
    throw new AppError('VALIDATION_FAILED', `请填写撤销${exitKindLabel(kind)}原因`, {
      reason: 'EXIT_CANCEL_REASON_REQUIRED',
    });
  return reason;
};

/**
 * 锁序（org/locks.ts 全局序，与生效链一致）：员工闭包 → 离职业务头 → ④ 组织设置（有未落地调动时 ⑤ 编制）→ 审批实例（状态迁移内 cancel）。
 * approved / effective 要做 §6B 的编制判定，编制锁一律取；未办结的情况不涉及占用，只取 lockExitOrganizationResources 约定的资源。
 */
async function lockForCancel(tx: Tx, ctx: EmploymentContext, businessId: string, withEstablishment: boolean) {
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId" FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
  );
  if (!owner) throw new AppError('NOT_FOUND', '离职单不存在');
  await lockTransferParticipants(tx, ctx, owner.employeeId);
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  await lockExitOrganizationResources(tx, ctx, owner.employeeId, businessId);
  if (withEstablishment)
    await lockEstablishment(tx, { ...ctx, userId: auditActor(ctx.userId) }, { initializeDefault: false });
  return business;
}

/** 锁前的业务头（状态 + 业务类型）：不是离职 / 退休单一律 404（文案按类型）。 */
async function loadCancelHead(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [head] = rowsOf<{ state: string; kind: string }>(
    await tx.execute(sql`SELECT s.state, p.kind FROM employment_business_objects b
      JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
        ORDER BY event_no DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT kind FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id
        ORDER BY version_no DESC LIMIT 1) p ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.id=${businessId}::uuid`),
  );
  if (!head || !isExitKind(head.kind as BusinessKind))
    throw new AppError('NOT_FOUND', `${exitKindLabel(head?.kind ?? 'leave')}单不存在`);
  return head;
}

export async function cancelExit(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  input: CancelInput,
  options: { readonly replacementUntil?: string } = {},
): Promise<CancelReceipt> {
  const head = await loadCancelHead(tx, ctx, businessId);
  const reason = textReason(input.reason, head.kind);
  const occupying = head.state === 'approved' || head.state === 'effective';
  const business = await lockForCancel(tx, ctx, businessId, occupying);
  const exit = await loadExitRequest(tx, ctx.tenantId, businessId);
  if (!exit) throw new AppError('NOT_FOUND', `${exitKindLabel(head.kind)}单不存在`);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  // 锁后以最新状态判定（等锁期间业务可能已被生效 / 撤销，revision 不符已在 lockEmploymentBusiness 拒绝）
  const cancelCase = exitCancelCase(business.state, today, business.payload.lastWorkDate);
  const stateBefore = business.state;
  const before = occupying ? await loadOccupancy(tx, ctx, business.employeeId) : null;

  // 状态迁移：未办结草稿删除；审批中 / 已驳回 / 已批准作废（revoke）；已生效删除（墓碑 + 时间轴恢复 + 挂回未来调动）
  const action = stateBefore === 'draft' || stateBefore === 'effective' ? 'delete' : 'revoke';
  const result = await transitionEmployment(tx, ctx, {
    id: businessId,
    action,
    cancelling: true,
    restoreUntil: options.replacementUntil,
  });
  // 结束在途 / 退回中的审批实例（审批通过的申请没有活动实例，钩子无事可做）
  await employmentApprovalHooks.deleted(tx, ctx, businessId);
  if (before && !options.replacementUntil)
    await assertOccupancyChange(tx, ctx, business.employeeId, businessId, before, input.confirmed === true);

  const downstream = await probeDownstream(tx, ctx, {
    employeeId: business.employeeId,
    lastWorkDate: business.payload.lastWorkDate,
    businessId,
  });
  const [row] = await tx
    .insert(exitCancellations)
    .values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      businessId,
      employeeId: business.employeeId,
      stateBefore,
      cancelCase,
      reason,
      downstream,
      commandId: ctx.commandId,
      actorUserId: ctx.userId,
      createdAt: ctx.now,
    })
    .returning();
  await auditEmployment(
    tx,
    ctx,
    'exit.request.cancel',
    'exit-request',
    businessId,
    { state: stateBefore },
    { state: result.status, case: cancelCase, reason, cancellationId: row!.id, kind: head.kind },
    undefined,
    undefined,
    { employeeId: business.employeeId },
  );
  await runExitCancelledHooks(tx, ctx, {
    businessId,
    employeeId: business.employeeId,
    stateBefore,
    case: cancelCase,
    kind: head.kind === 'retirement' ? 'retirement' : 'leave',
  });
  return {
    ...result,
    cancellation: {
      id: row!.id,
      case: cancelCase,
      stateBefore,
      reason,
      revision: row!.revision,
      createdAt: row!.createdAt.toISOString(),
    },
    downstream,
  };
}

/** 撤销记录里可事后修改的只有撤销原因（DM-R5，revision 乐观锁，审计 exit.cancellation.update）。 */
export async function updateCancellationReason(
  tx: Tx,
  ctx: EmploymentContext,
  cancellationId: string,
  reasonInput: string,
) {
  const [current] = await tx
    .select()
    .from(exitCancellations)
    .where(and(eq(exitCancellations.tenantId, ctx.tenantId), eq(exitCancellations.id, cancellationId)))
    .for('update');
  if (!current) throw new AppError('NOT_FOUND', '撤销的离职记录不存在');
  const kind = (await businessKind(tx, ctx.tenantId, current.businessId)) ?? 'leave';
  const reason = textReason(reasonInput, kind);
  if (current.revision !== ctx.expectedRevision)
    throw new AppError('REVISION_CONFLICT', '撤销记录已被修改，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: current.revision,
    });
  const [updated] = await tx
    .update(exitCancellations)
    .set({ reason, revision: current.revision + 1 })
    .where(and(eq(exitCancellations.tenantId, ctx.tenantId), eq(exitCancellations.id, cancellationId)))
    .returning();
  await auditEmployment(
    tx,
    ctx,
    'exit.cancellation.update',
    'exit-cancellation',
    cancellationId,
    { reason: current.reason, kind },
    { reason, kind },
    undefined,
    undefined,
    { employeeId: current.employeeId },
  );
  return {
    id: updated!.id,
    businessId: updated!.businessId,
    employeeId: updated!.employeeId,
    case: updated!.cancelCase,
    stateBefore: updated!.stateBefore,
    reason: updated!.reason,
    revision: updated!.revision,
    createdAt: updated!.createdAt.toISOString(),
  };
}

/**
 * 该幂等键是否已被本业务的“撤销命令”用过（回执带 cancellation）。通用 DELETE 对离职单的分流依赖当前状态
 * （可撤销 → 撤销；已作废 / 已删除 → 清理）；首次撤销后状态已变，重放必须仍走撤销分支才能得到同一指纹与首次回执，
 * 而清理命令的重放（回执不带 cancellation）和新键的清理走通用 delete（第 1 轮审查 P2-3）。
 */
export async function isCancelReplay(tx: Tx, tenantId: string, key: string | undefined, businessId: string) {
  if (!key) return false;
  const [row] = rowsOf<{ found: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM command_ledger WHERE tenant_id=${tenantId}
      AND command_id=${key} AND response_status < 400 AND response_body ? 'cancellation'
      AND response_body->>'id' = ${businessId}) AS found`),
  );
  return Boolean(row?.found);
}

/** 撤销记录所属员工（入口先验范围 / 按钮用）；不存在返回 undefined。 */
export async function cancellationOwner(tx: Tx, tenantId: string, cancellationId: string) {
  const [row] = await tx
    .select({ employeeId: exitCancellations.employeeId, businessId: exitCancellations.businessId })
    .from(exitCancellations)
    .where(and(eq(exitCancellations.tenantId, tenantId), eq(exitCancellations.id, cancellationId)));
  return row;
}

/** restore（设计 §7.3，退休 R2-T04 §6 第 7 行同样不支持）：已撤销 / 作废的不能恢复。授权已由入口完成，这里只给统一拒绝。 */
export function rejectRestore(kind: 'leave' | 'retirement' = 'leave'): never {
  const label = exitKindLabel(kind);
  throw new AppError('CONFLICT', `已撤销的${label}不能恢复，请重新办理${label}`, {
    reason: 'EXIT_RESTORE_NOT_SUPPORTED',
  });
}
