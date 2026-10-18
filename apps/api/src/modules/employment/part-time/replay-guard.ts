/**
 * 兼职写入口的命令内权限复核（设计 §7.2 / §7.3A 第 1 层，PT-3b：新增 / 预览），照 employment/replay-guard.ts 的 scopedGuard 写法：
 * runCommand 的三个出口（首次、同键重放、失败回查）都先在命令事务内按**当前**授权重跑 §7.2 该入口整行——员工主职在范围、兼职部门
 * 在范围、新增权 + Employment.PartTime 按钮 + 字段创建权——撤权后重放拿不到台账原响应；原响应里的兼职记录另过统一结果复核
 * （permission/employment-replay.ts，兼职部门取记录当前值，PB-69）。入口与命令内共用 requirePartTimeCreateAccess。
 */
import { buttonResource, PART_TIME_BUTTONS } from '@italent/domain';
import type { Tx } from '@italent/db';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import {
  EMPLOYMENT_OBJECT,
  commandContext,
  requireEmployeeInScope,
  requireEmploymentScope,
  requireEmploymentWrite,
  scopedGuard,
  type ScopedCommandGuard,
} from '../context.js';
import type { EmploymentContext } from '../types.js';

export interface PartTimeCreateTarget {
  readonly employeeId: string;
  /** requireEmploymentWrite 的载荷：实际写入的字段（兼职类型 / 开始日期 / 结束日期 / 预置字段 / 自定义字段）。 */
  readonly business: object;
  readonly departmentId: string;
}

/** §7.2 预览 / 直接新增行：看全部别名写权 → 员工主职在范围 → 新增权 + 按钮 + 字段创建权 → 兼职部门在范围。 */
export async function requirePartTimeCreateAccess(
  tx: Tx,
  scoped: EmploymentContext,
  target: PartTimeCreateTarget,
): Promise<void> {
  if (scoped.trustedScopeBypass)
    await requirePermission(scoped.authorize!, {
      ...scoped,
      action: 'tenant.employment.write',
      resource: target.employeeId,
    });
  await requireEmployeeInScope(tx, scoped, target.employeeId);
  await requireEmploymentWrite(scoped, 'create', target.business, PART_TIME_BUTTONS.direct);
  requireEmploymentScope(scoped, target.employeeId, target.departmentId);
}

/** 直接新增的命令内复核：按当前授权在命令事务内重过 requirePartTimeCreateAccess。 */
export function partTimeCreateGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  target: PartTimeCreateTarget,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => requirePartTimeCreateAccess(tx, await commandContext(tx, deps, ctx), target),
  });
}

/** 预览：新增兼职 / 新增兼职申请两个按钮任一即可（§7.2 预览行），两项都无 403。 */
export async function requirePartTimePreviewButton(deps: TenantRouteDeps, ctx: EmploymentContext): Promise<void> {
  const held = async (code: string) =>
    deps.authorize({ ...ctx, action: 'object.button', resource: buttonResource(EMPLOYMENT_OBJECT, code, 'detail') });
  if (!(await held(PART_TIME_BUTTONS.direct)) && !(await held(PART_TIME_BUTTONS.application)))
    throw new AppError('FORBIDDEN', '没有新增兼职的权限');
}
