import type { Tx } from '@italent/db';
import type { EmploymentContext } from '../employment/types.js';
import { auditActor } from '../../system-actor.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { creatorOf, hasCreatorScope, visible, writeFields, type ModuleScope } from './module-route-access.js';
import type { ScopeBusinessContext } from './module-contracts.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from './module-access.js';
import type { EstablishmentContext } from '../establishment/store.js';

/** HTTP 提供事务内钩子；自动补月、跨期调整、复制和同步祖先不能越过发起人的范围/字段权限。 */
export function capacityContext(
  deps: Pick<TenantRouteDeps, 'authorize'>,
  ctx: ScopeBusinessContext,
  scope: ModuleScope,
): EstablishmentContext {
  return {
    ...ctx,
    authorizeCapacity: async (tx, change) => {
      const creator =
        change.operation === 'create'
          ? ctx.userId
          : change.id && hasCreatorScope(scope)
            ? await creatorOf(tx, ctx.tenantId, change.id, 'establishment.capacity.create', 'establishment-capacity')
            : undefined;
      try {
        visible(scope, change.orgId, '编制在该时点不存在', creator);
      } catch (error) {
        if (change.linked && error instanceof AppError && error.code === 'NOT_FOUND') {
          // DEC-178：联动改写的上级编制对操作人可见（组织在范围内）即改写，否则整单拒绝并保留 DEC-084 拒绝码。
          // 编制记录没有员工维度，DEC-177 的“员工当前部门”一支不适用，可见即上面 visible() 的组织判断。
          throw new AppError('LINKED_RECORD_OUT_OF_SCOPE', '联动记录不在当前数据范围，请由覆盖该范围的人员操作');
        }
        throw error;
      }
      await writeFields(
        { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) },
        ctx,
        MODULE_OBJECTS.establishment.code,
        change.operation,
        change.payload,
      );
    },
  };
}

/** 带编写入独立解析编制对象范围，不能继承任职范围或调入选择例外。 */
export async function employmentCapacityContext(tx: Tx, ctx: EmploymentContext): Promise<EstablishmentContext> {
  const actor = { ...ctx, userId: auditActor(ctx.userId) };
  // 无授权器的内部调度/审批端口沿用已有可信服务上下文；任职 HTTP 写入口始终注入授权器。
  if (!ctx.authorize) return actor;
  const scope = await resolveModuleScopeInTransaction(
    { authorize: ctx.authorize, clock: () => ctx.now },
    ctx,
    tx,
    MODULE_OBJECTS.establishment.code,
  );
  return { ...capacityContext({ authorize: ctx.authorize }, ctx, scope), userId: actor.userId };
}
