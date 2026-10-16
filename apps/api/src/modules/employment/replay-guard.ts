/**
 * 命令内的写权限复核（CommandGuard.before）：F-195 / F-197，DEC-406 权限类后补。
 * runCommand 的三个出口（首次执行、同键直接重放、失败后回查）都先过 before，所以撤权后重放拿不到台账里的原响应。
 * 入口（事务外）的复核只管本次请求，管不到“入口放行之后、命令事务之前”的撤权；命令内的权限依赖与数据范围都在这里
 * 按当前授权重新取得（事务内绑定的授权器、事务内解析的数据范围），不沿用入口取到的快照。
 */
import type { Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { requirePermission, type Authorizer } from '../../authorization.js';
import type { CommandGuard } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { EMPLOYMENT_OBJECT, requireEmploymentWrite, requireScopedEmploymentObject } from './context.js';
import { isExitKind, requireExitPermission } from './exit-gate.js';
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

/** 命令事务内的上下文：授权器绑定到本事务，数据范围按当前授权在本事务内重新解析（入口的范围只是请求内快照）。 */
async function commandContext(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext): Promise<EmploymentContext> {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const scope = ctx.scope
    ? await resolveModuleScopeInTransaction(deps, ctx, tx, ctx.objectCode ?? EMPLOYMENT_OBJECT)
    : undefined;
  return { ...ctx, authorize, scope };
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
export function exitEditGuard(deps: TenantRouteDeps, ctx: EmploymentContext, targets: readonly EditTarget[]) {
  const exits = targets.filter((target) => isExitKind(target.kind));
  if (!exits.length) return undefined;
  const guard: CommandGuard = {
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requireObjectUpdate(scoped);
      for (const target of exits) {
        await requireBusinessWriteScope(tx, scoped.authorize!, scoped, target.id, target.employeeId);
        const departmentId = target.patch.fields?.departmentId;
        if (departmentId !== undefined)
          await requireScopedEmploymentObject(tx, scoped, target.employeeId, departmentId, target.id);
        await requireExitPermission(scoped, 'update', { employeeId: target.employeeId, patch: target.patch });
      }
    },
  };
  return guard;
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
): CommandGuard {
  return {
    before: async (tx) => {
      const scoped = await commandContext(tx, deps, ctx);
      await requireObjectUpdate(scoped);
      await requireEmploymentWrite(scoped, 'update', payload, 'Employment.Edit');
      await requireBusinessWriteScope(tx, scoped.authorize!, scoped, id);
    },
  };
}
