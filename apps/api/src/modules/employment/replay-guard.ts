/**
 * 命令内的写权限复核（CommandGuard.before）：F-195 / F-197，DEC-406 权限类后补。
 * runCommand 的三个出口（首次执行、同键直接重放、失败后回查）都先过 before，所以撤权后重放拿不到台账里的原响应。
 * 入口（事务外）的复核只管本次请求，管不到“入口放行之后、命令事务之前”的撤权；命令内的权限依赖与数据范围都在这里
 * 按当前授权重新取得（commandContext：事务内绑定的授权器、事务内解析的数据范围），不沿用入口取到的快照。
 * 这些 guard 都带 scopedGuard 标记：runWrite 让执行、提交前结果校验和重放复核（业务当前值 / 原响应快照 / 命令足迹）
 * 也用同一份事务内范围，所以这里只负责前置检查。
 */
import type { Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  EMPLOYMENT_OBJECT,
  commandContext,
  requireEmployeeInScope,
  requireEmploymentScope,
  requireEmploymentWrite,
  requireScopedEmploymentObject,
  scopedGuard,
  type ScopedCommandGuard,
} from './context.js';
import { isExitKind, requireExitPermission, type ExitGateTarget, type ExitOperation } from './exit-gate.js';
import { loadEmploymentBusiness } from './read-model.js';
import type { BusinessKind, EmploymentBusinessPatch, EmploymentContext } from './types.js';

/**
 * 写入口径范围：业务在操作人当前数据范围内（范围外与不存在同一个 404），看全部别名另要任职写权。
 * 入口（authorizeBusinessWrite，事务外）与命令内复核共用这一份。幂等重放也要重验，不能依赖可能被命令台账跳过的 execute。
 */
export async function requireBusinessWriteScope(
  tx: Tx,
  authorize: Authorizer,
  ctx: EmploymentContext,
  id: string,
  employeeId?: string,
) {
  const value = await loadEmploymentBusiness(
    tx,
    ctx.tenantId,
    id,
    tenantLocalDate(ctx.now, ctx.timezone),
    ctx.transferTarget ? undefined : ctx.scope,
    'write',
  );
  if (!value || (employeeId && value.employeeId !== employeeId)) throw new AppError('NOT_FOUND', '任职业务不存在');
  if (ctx.trustedScopeBypass)
    await requirePermission(authorize, { ...ctx, action: 'tenant.employment.write', resource: value.employeeId });
  return value;
}

/** 入口 readContext 的对象编辑权判定（不带字段），命令内按当前授权再过一遍。 */
function requireObjectUpdate(ctx: EmploymentContext) {
  return requirePermission(ctx.authorize!, {
    ...ctx,
    action: 'object.update',
    resource: ctx.objectCode ?? EMPLOYMENT_OBJECT,
    fields: [],
  });
}

export interface EditTarget {
  readonly id: string;
  readonly employeeId: string;
  readonly kind: BusinessKind;
  readonly patch: EmploymentBusinessPatch;
}

/**
 * 记录编辑 / 批量编辑 / 导入编辑行三条路径共用的离职复核：目标里有离职 / 退休记录时，命令内重过范围与 Dimission* 权限链
 * （editEmploymentRecord 内同一道门只在真正执行时才跑，命中台账的重放到不了那里）。没有离职目标不挂，行为不变。
 */
export function exitEditGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  targets: readonly EditTarget[],
): ScopedCommandGuard | undefined {
  const exits = targets.filter((target) => isExitKind(target.kind));
  if (!exits.length) return undefined;
  return scopedGuard({
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requireObjectUpdate(scoped);
      for (const target of exits) {
        await requireEmployeeInScope(tx, scoped, target.employeeId);
        await requireBusinessWriteScope(tx, scoped.authorize!, scoped, target.id, target.employeeId);
        const departmentId = target.patch.fields?.departmentId;
        if (departmentId !== undefined)
          await requireScopedEmploymentObject(tx, scoped, target.employeeId, departmentId, target.id);
        await requireExitPermission(scoped, 'update', { employeeId: target.employeeId, patch: target.patch });
      }
    },
  });
}

/**
 * 待入职行内编辑（F-188 PATCH /pending-entries/:id）的命令内复核：对象编辑权、Employment.Edit 按钮、入职日期等字段写权限、
 * 写入口径数据范围，口径与入口 prepareEntryAction 相同，只是改按当前授权在命令事务内重过。
 */
export function pendingEditGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  payload: object,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requireObjectUpdate(scoped);
      await requireEmploymentWrite(scoped, 'update', payload, 'Employment.Edit');
      await requireBusinessWriteScope(tx, scoped.authorize!, scoped, id);
    },
  });
}

/** 离职入口命令内复核的范围目标：已有业务按业务 + 员工 + 目标部门校验；创建（还没有业务）按员工 + 目标部门。 */
export interface ExitScopeTarget {
  readonly businessId?: string;
  readonly departmentId?: string | null;
}

/**
 * 离职入口（create / PATCH / submit / withdraw / DELETE /businesses/:id / activation/retry）的命令内复核（#199，F-195）：
 * 首次执行、同键重放、失败回查三个出口都先在命令事务内按当前授权重新解析数据范围，校验员工、业务和请求里显式给出的
 * 目标部门的写入范围，再过 Dimission* 权限链。创建时没填的部门是从时间线继承来的（PATCH 也会重算继承），请求里看不到，
 * 由 runWrite 在同一份事务内范围上校验实际写入的结果（执行后）和原响应（重放时）。
 */
export function exitCommandGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  operation: ExitOperation,
  target: ExitGateTarget,
  scopeTarget: ExitScopeTarget,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requireExitScope(tx, scoped, target, scopeTarget);
      await requireExitPermission(scoped, operation, target);
    },
  });
}

async function requireExitScope(
  tx: Tx,
  scoped: EmploymentContext,
  target: ExitGateTarget,
  scopeTarget: ExitScopeTarget,
) {
  const { businessId } = scopeTarget;
  const departmentId = scopeTarget.departmentId ?? target.patch?.fields?.departmentId;
  if (businessId) {
    // 员工当前范围与业务（记录部门）范围是两项：组织维度下，业务部门可以和员工当前所在部门不同
    await requireEmployeeInScope(tx, scoped, target.employeeId);
    await requireBusinessWriteScope(tx, scoped.authorize!, scoped, businessId, target.employeeId);
    if (departmentId !== undefined)
      await requireScopedEmploymentObject(tx, scoped, target.employeeId, departmentId, businessId);
    return;
  }
  await requireEmployeeInScope(tx, scoped, target.employeeId);
  if (scoped.trustedScopeBypass)
    await requirePermission(scoped.authorize!, {
      ...scoped,
      action: 'tenant.employment.write',
      resource: target.employeeId,
    });
  if (departmentId !== undefined) requireEmploymentScope(scoped, target.employeeId, departmentId);
}
