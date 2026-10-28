/**
 * 实习列表逐行可用动作（F-283，DEC-654 批 3）：GET interns 每行的 availableActions。读口不另写一套判断，而是对每行跑写入口
 * 同一组判定（DEC-431①），保证“读口给出的动作 = 写口会接受的动作”：
 * - regularize（POST interns/:id/regularize）：实习中 / 实习转正中的行 → requireInternRegularizationAccess（新增权 + Employment.Create
 *   + 转正必填字段的写权 + 员工范围）；目标部门读口还不知道，只判员工范围，部门范围留给写入口；
 * - terminate（POST interns/:id/terminate）：同视图 → requireExitCommandAccess（员工范围 + 直接离职权限链）；
 * - withdraw / revoke（POST businesses/:id/{动作}）：实习转正中的审批中单据 → 状态机 transitionPermitted + 更新权 + 同名按钮 +
 *   业务写入口径范围。写入口对非离职单没有“原发起人”校验，读口同样不加。
 * 只判权限、视图归属与状态；超编确认、在途转正确认、结束日冲突等业务校验仍由写入口判。
 * 单据状态字段对当前操作人不可见时不下发撤回 / 撤销（动作集合不泄露状态）。
 */
import { withTenant, type Tx } from '@italent/db';
import { tenantLocalDate, type InternView } from '@italent/domain';
import type { Context } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { permits, requireEmploymentWrite, tryWriteContext } from './context.js';
import type { InternViewItem } from './intern-views.js';
import { regularizationBusiness } from './intern-regularization.js';
import { internTerminationGate } from './intern-termination.js';
import {
  requireBusinessWriteScope,
  requireExitCommandAccess,
  requireInternRegularizationAccess,
} from './replay-guard.js';
import { transitionPermitted } from './transitions.js';
import type { EmploymentContext } from './types.js';

/** 下发顺序固定：转正 → 结束实习 → 撤回 → 撤销。 */
export type InternAction = 'regularize' | 'terminate' | 'withdraw' | 'revoke';

const TRANSITION_BUTTONS = { withdraw: 'Employment.Withdraw', revoke: 'Employment.Revoke' } as const;

async function requireTransitionAccess(
  tx: Tx,
  scoped: EmploymentContext,
  businessId: string,
  action: keyof typeof TRANSITION_BUTTONS,
) {
  await requireEmploymentWrite(scoped, 'update', {}, TRANSITION_BUTTONS[action]);
  await requireBusinessWriteScope(tx, scoped.authorize!, scoped, businessId);
}

interface WriteContexts {
  readonly create: EmploymentContext | undefined;
  readonly update: EmploymentContext | undefined;
}

async function rowActions(
  tx: Tx,
  contexts: WriteContexts,
  view: InternView,
  today: string,
  stateVisible: boolean,
  item: InternViewItem,
): Promise<InternAction[]> {
  const offered: InternAction[] = [];
  const { create, update } = contexts;
  // 实习中 / 实习转正中的人都还是实习生（实习转正中可直接转正，在途申请自动作废，DEC-593）
  if (create && (view === 'interning' || view === 'converting')) {
    const business = regularizationBusiness({ effectiveDate: today, departmentId: item.departmentId ?? '' });
    if (await permits(() => requireInternRegularizationAccess(tx, create, item.employeeId, business)))
      offered.push('regularize');
    const gate = internTerminationGate(item.employeeId, today);
    if (await permits(() => requireExitCommandAccess(tx, create, 'create', gate, {}))) offered.push('terminate');
  }
  if (update && stateVisible && view === 'converting') {
    const business = { state: item.state, payload: { mode: 'application', kind: item.kind } } as const;
    for (const action of ['withdraw', 'revoke'] as const)
      if (
        transitionPermitted(business, action) &&
        (await permits(() => requireTransitionAccess(tx, update, item.id, action)))
      )
        offered.push(action);
  }
  return offered;
}

/** 与 items 一一对应的每行可用动作。 */
export async function internRowActions(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  view: InternView,
  items: readonly InternViewItem[],
  stateVisible: boolean,
): Promise<InternAction[][]> {
  const contexts = {
    create: await tryWriteContext(c, deps, 'object.create'),
    update: await tryWriteContext(c, deps, 'object.update'),
  };
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const result: InternAction[][] = [];
    for (const item of items) result.push(await rowActions(tx, contexts, view, today, stateVisible, item));
    return result;
  });
}
