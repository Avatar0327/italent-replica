import type { CommandGuard } from '../../commands.js';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import { commandContext, requireEmploymentWrite } from './context.js';
import type { EmploymentContext } from './types.js';

/** F-474-6b-0：入口同一授权判定在 ledgerExit.before 复核，覆盖执行、重放和失败回查。 */
export function customFieldWriteGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  operation: 'create' | 'update',
  input: object,
): CommandGuard {
  return {
    before: async (tx) => {
      const current = await commandContext(tx, deps, ctx);
      await requirePermission(current.authorize!, {
        ...current,
        action: 'tenant.employment.configuration.write',
        resource: 'TenantBase.EmploymentCustomField',
      });
      await requireEmploymentWrite(current, operation, input, undefined, 'TenantBase.EmploymentCustomField');
    },
  };
}
