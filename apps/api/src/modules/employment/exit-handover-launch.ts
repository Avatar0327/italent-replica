/** F-250 / DEC-683：触发资格共用入口；不改变 F-305 重提与取人规则。 */
import { sql, type Tx } from '@italent/db';
import { addDays, HANDOVER_SUBMIT_BUTTON, handoverLaunchDecision, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  assertRevision,
  commandContext,
  requireEmployeeInScope,
  requireEmploymentWrite,
  scopedGuard,
} from './context.js';
import { loadExitRequest } from './exit-gate.js';
import { createExitHandover, lastWorkDateOf, readTrigger } from './exit-handover.js';
import { latestHandoverOfExit } from './exit-handover-store.js';
import { findCurrentRecord, loadEmploymentBusiness } from './read-model.js';
import { lockEmploymentBusiness, lockEmploymentEmployee, rowsOf } from './record-store.js';
import { requireBusinessWriteScope } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

type Moment = 'on_submit' | 'on_node_approved' | 'on_approval_passed' | 'due';
const skip = (reason: string) => ({ outcome: 'skipped' as const, reason });

/** 自动触发的输入只能来自真实提交 / 审批动作 / 调度；调用方已持员工锁。 */
export async function automaticHandover(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  moment: Moment,
  nodeKey?: string,
  approvedOnOverride?: string,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const business = await loadEmploymentBusiness(tx, ctx.tenantId, id, today);
  if (
    !business ||
    business.kind !== 'leave' ||
    business.mode !== 'application' ||
    !['in_review', 'approved', 'effective'].includes(business.status)
  )
    return skip('NOT_APPLICABLE');
  const setting = await readTrigger(tx, ctx.tenantId);
  if (!setting.enabled) return skip('DISABLED');
  const dated = setting.method === 'days_before_last_work_date';
  if (moment === 'due' ? !dated : setting.method !== moment && !(dated && moment === 'on_approval_passed'))
    return skip('OTHER_METHOD');
  if (moment === 'on_node_approved' && nodeKey !== setting.nodeKey) return skip('OTHER_NODE');
  if (moment === 'on_submit' || moment === 'on_node_approved') {
    const current = await findCurrentRecord(tx, ctx.tenantId, business.employeeId, today);
    if (current?.fields.employType !== 'internal' && current?.fields.employType !== 'intern')
      return skip('EMPLOYMENT_NOT_ELIGIBLE');
  }
  const exit = await loadExitRequest(tx, ctx.tenantId, id);
  if (!exit) return skip('NOT_APPLICABLE');
  if (moment === 'on_approval_passed' || moment === 'due') {
    if (!['approved', 'effective'].includes(business.status)) return skip('NOT_APPROVED');
    const approvedOn = approvedOnOverride ?? exit.preReleaseDate;
    const lastWorkDate = await lastWorkDateOf(tx, ctx.tenantId, id);
    if (!approvedOn || !lastWorkDate) return skip('NOT_APPROVED');
    const decision = handoverLaunchDecision(setting, { lastWorkDate, approvedOn });
    if (decision !== 'launch') return skip(decision.toUpperCase());
    // DEC-683：提前超过 / 恰好 / 不足 N 天均到 L 次日；N 不是 L−N 调度偏移。
    if (dated && approvedOn < lastWorkDate && today < addDays(lastWorkDate, 1)) return skip('NOT_DUE');
  }
  // 自动事件不重开旧单：失败交给 F-305，终止交给显式重提，调度补跑不会复活旧流程。
  const existing = await latestHandoverOfExit(tx, ctx.tenantId, id);
  if (existing) return { outcome: 'exists' as const, requestId: existing.id };
  return createExitHandover(tx, ctx, {
    businessId: id,
    employeeId: business.employeeId,
    kind: 'leave',
    mode: 'application',
    reEmployed: false,
  });
}

/** 新写入口和 ledgerExit.before 使用同一授权检查。 */
export async function requireHandoverSubmit(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  button: string = HANDOVER_SUBMIT_BUTTON.code,
) {
  await requireEmploymentWrite(ctx, 'update', {}, button, undefined, { commandOnly: true });
  try {
    const business = await requireBusinessWriteScope(tx, ctx.authorize!, ctx, id);
    if (business.kind !== 'leave' || !(await loadExitRequest(tx, ctx.tenantId, id)))
      throw new AppError('NOT_FOUND', '任职业务不存在');
    await requireEmployeeInScope(tx, ctx, business.employeeId);
    return business;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') throw new AppError('NOT_FOUND', '任职业务不存在');
    throw error;
  }
}
export function handoverSubmitGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  button: string = HANDOVER_SUBMIT_BUTTON.code,
) {
  return scopedGuard({
    before: async (tx) => {
      const [owner] = rowsOf<{ employeeId: string }>(
        await tx.execute(sql`SELECT employee_id AS "employeeId"
      FROM employment_business_objects WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`),
      );
      if (!owner) throw new AppError('NOT_FOUND', '任职业务不存在');
      await lockEmploymentEmployee(tx, ctx, owner.employeeId);
      await tx.execute(sql`SELECT id FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid FOR UPDATE`);
      await requireHandoverSubmit(tx, await commandContext(tx, deps, ctx), id, button);
    },
  });
}
export async function submitExitHandover(tx: Tx, ctx: EmploymentContext, id: string) {
  const locked = await lockEmploymentBusiness(tx, ctx, id);
  assertRevision(ctx.expectedRevision, locked.revision);
  if (!['in_review', 'approved', 'effective'].includes(locked.state))
    throw new AppError('CONFLICT', '当前离职状态不能发起交接', { reason: 'EXIT_HANDOVER_NOT_SUBMITTABLE' });
  if (await latestHandoverOfExit(tx, ctx.tenantId, id))
    throw new AppError('CONFLICT', '已有交接单；未发起或已终止的交接请使用重新提交', {
      reason: 'EXIT_HANDOVER_EXISTS',
    });
  const result = await createExitHandover(
    tx,
    ctx,
    {
      businessId: id,
      employeeId: locked.employeeId,
      kind: 'leave',
      mode: locked.payload.mode,
      reEmployed: false,
    },
    ctx.userId,
  );
  if (!('requestId' in result)) throw new AppError('CONFLICT', '交接发起失败', { reason: result.reason });
  return {
    exitRequestId: id,
    requestId: result.requestId,
    outcome: result.outcome,
    revision: locked.revision,
    ...('reason' in result ? { reason: result.reason } : {}),
  };
}

/** 复用任职调度的员工批次、RLS、游标与 SKIP LOCKED；不建新调度器。 */
export function dueHandoverCandidates(tenantId: string, today: string) {
  return sql`SELECT e.employee_id::text AS "employeeId", e.business_id AS id FROM exit_requests e
    JOIN LATERAL (SELECT kind, last_work_date FROM employment_payload_versions p
      WHERE p.tenant_id=e.tenant_id AND p.business_id=e.business_id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=e.tenant_id AND s.business_id=e.business_id ORDER BY event_no DESC LIMIT 1) s ON true
    WHERE e.tenant_id=${tenantId} AND e.mode='application' AND p.kind='leave'
      AND s.state IN ('approved','effective') AND e.pre_release_date IS NOT NULL
      AND p.last_work_date + 1 <= ${today}::date
      AND NOT EXISTS (SELECT 1 FROM exit_handover_requests h
        WHERE h.tenant_id=e.tenant_id AND h.exit_request_id=e.business_id)`;
}
export async function runDueHandovers(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const setting = await readTrigger(tx, ctx.tenantId);
  if (!setting.enabled || setting.method !== 'days_before_last_work_date') return;
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM
    (${dueHandoverCandidates(ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))}) h
    WHERE h."employeeId"=${employeeId} ORDER BY id`),
  );
  for (const row of rows) await automaticHandover(tx, ctx, row.id, 'due');
}

export async function readDueHandoverEnabled(tx: Tx, tenantId: string) {
  const setting = await readTrigger(tx, tenantId);
  return setting.enabled && setting.method === 'days_before_last_work_date';
}
