/**
 * 离职生效时作废在途考核（F-229，DEC-617；R2-T03 设计 §5.1 步骤 8 的 effective 端口订阅方）。
 * 订阅 exitPostEffectHooks.onEffective，与离职生效同一事务、同一保存点：失败即整单回滚。三种生效来源
 * （approval / direct / free_direct）都经 activateExit，因此都覆盖。生效前考核保持在途不变（本文件只在生效后运行）。
 * 对该员工的每条在途考核（assessment-in-flight.ts 同一查询）：状态置“已作废”（终态、只读）→ 终止审批实例并移除待办 → 审计。
 * 锁序：员工（离职已持有）→ 考核记录按 ID 升序 → 审批实例，与审批回调（assessment-approval-adapter.ts）一致，
 * 审批通过与离职生效并发时只有先拿到员工锁的一方成功。
 * 复刻取舍：终态沿用考核的 cancelled（已作废），不新增状态；生效后撤销离职不恢复考核（DEC-617“终止作废”）。
 */
import type { Tx } from '@italent/db';
import { cancel } from '../approval/actions.js';
import { schedulerAwareContext } from '../approval/context.js';
import { activeInstanceOf } from '../approval/store.js';
import { inFlightAssessments } from './assessment-in-flight.js';
import { loadAssessment, saveAssessment } from './assessment-store.js';
import { exitPostEffectHooks, type ExitEffectiveEvent } from './exit-confirmation.js';
import type { EmploymentContext } from './types.js';

export interface VoidedAssessment {
  readonly id: string;
  readonly stateBefore: string;
  readonly instanceId: string | null;
}

/** 作废该员工全部在途考核；返回被作废的清单（供调用方 / 测试核对）。 */
export async function voidInFlightAssessments(
  tx: Tx,
  ctx: EmploymentContext,
  event: Pick<ExitEffectiveEvent, 'businessId' | 'employeeId' | 'lastWorkDate' | 'effectiveDate'>,
): Promise<VoidedAssessment[]> {
  const approvalCtx = schedulerAwareContext(ctx);
  const voided: VoidedAssessment[] = [];
  for (const candidate of await inFlightAssessments(tx, ctx.tenantId, event.employeeId, true)) {
    const row = await loadAssessment(tx, ctx.tenantId, candidate.id, true);
    const active = await activeInstanceOf(tx, ctx.tenantId, 'probation_assessment', row.id);
    await saveAssessment(tx, ctx, row, { status: 'cancelled' }, 'voided_by_exit', {
      exitBusinessId: event.businessId,
      lastWorkDate: event.lastWorkDate,
      effectiveDate: event.effectiveDate,
      instanceId: active?.id ?? null,
    });
    if (active) await cancel(tx, approvalCtx, active.id);
    voided.push({ id: row.id, stateBefore: row.status, instanceId: active?.id ?? null });
  }
  return voided;
}

exitPostEffectHooks.onEffective((tx, ctx, event) => voidInFlightAssessments(tx, ctx, event).then(() => undefined));
