import { MODULE_OBJECTS } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { creatorOf, hasCreatorScope, visible, writeFields, type ModuleScope } from './module-route-access.js';
import type { ScopeBusinessContext } from './module-contracts.js';
import { authorizeInTransaction } from './module-access.js';
import type { EstablishmentContext } from '../establishment/store.js';

/** HTTP 提供事务内钩子；自动补月、跨期调整、复制和同步祖先不能越过发起人的范围/字段权限。 */
export function capacityContext(
  deps: TenantRouteDeps,
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
          // TODO(需取证 Q-M0-33): 原站联动越权提示及引导文案待取证。
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
