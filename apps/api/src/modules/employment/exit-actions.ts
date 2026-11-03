import { withTenant } from '@italent/db';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { commandContext, requireEmployeeInScope } from './context.js';
import { isCancellableState } from './exit-cancel.js';
import type { ExitActionCode } from './exit-queries.js';
import { requireExitPermission } from './exit-gate.js';
import { requireBusinessWriteScope } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

/**
 * F-352①：离职单逐单动作契约。动作 = 单据状态 × 按钮权 × 写数据范围，三者都复用写入口自己的判定，
 * 前端只读 actions，不再按状态与权限快照推导。actions 是披露，不放宽任何准入（写入口仍各自复核）。
 *   submit  离职申请（HR 发起）的草稿 / 已驳回单
 *   edit    草稿 / 审批中 / 审批通过 / 已驳回 / 已生效
 *   cancel  同 isCancellableState
 *   handle  （B15“离职处理”，仅列表行）单据已办结且员工在写范围内，按直接离职按钮
 * 查看人没有“状态”字段权时调用方不应下发 actions（否则能由动作反推被裁剪的状态）。
 */
export type ExitAction = ExitActionCode;

export interface ExitActionSubject {
  readonly id: string;
  readonly employeeId: string;
  readonly status: string;
  readonly mode: 'application' | 'direct';
  readonly initiator: 'hr' | 'self' | 'manager';
}

const EDITABLE = ['draft', 'in_review', 'approved', 'rejected', 'effective'];
const SUBMITTABLE = ['draft', 'rejected'];
/** 在途 / 已生效的单不再给“离职处理”：同员工再办会被 EXIT_IN_PROGRESS 拦下。 */
const NOT_SETTLED = ['draft', 'in_review', 'approved', 'rejected', 'effective'];

/** 只吞“无权 / 不在范围”两类拒绝，其余（含基础设施错误）照常抛出。 */
async function allowed(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof AppError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) return false;
    throw error;
  }
}

export async function exitActions(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  subjects: readonly ExitActionSubject[],
  options: { readonly withHandle: boolean },
): Promise<Map<string, ExitAction[]>> {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const scoped = await commandContext(tx, deps, ctx);
    const result = new Map<string, ExitAction[]>();
    for (const subject of subjects) {
      const actions: ExitAction[] = [];
      const target = { employeeId: subject.employeeId, kind: 'leave' } as const;
      const inScope = await allowed(() => requireBusinessWriteScope(tx, scoped.authorize!, scoped, subject.id));
      if (inScope) {
        const canSubmit =
          subject.mode === 'application' && subject.initiator === 'hr' && SUBMITTABLE.includes(subject.status);
        if (canSubmit && (await allowed(() => requireExitPermission(scoped, 'submit', target)))) actions.push('submit');
        if (EDITABLE.includes(subject.status) && (await allowed(() => requireExitPermission(scoped, 'update', target))))
          actions.push('edit');
        if (
          isCancellableState(subject.status) &&
          (await allowed(() => requireExitPermission(scoped, 'cancel', target)))
        )
          actions.push('cancel');
      }
      const settled = !NOT_SETTLED.includes(subject.status);
      if (
        options.withHandle &&
        settled &&
        (await allowed(async () => {
          await requireEmployeeInScope(tx, scoped, subject.employeeId);
          await requireExitPermission(scoped, 'create', { ...target, mode: 'direct' });
        }))
      )
        actions.push('handle');
      result.set(subject.id, actions);
    }
    return result;
  });
}
